:global uhhBase
:global uhhToken
:global uhhRouterId
:global uhhTls
:global uhhConfigVersion
:global uhhUsageIntervalS
:global uhhHeartbeatIntervalS
:global uhhUsageTick
:global uhhUsageLastBody
/system script run uhh-config
:if ([:typeof $uhhUsageTick] != "num") do={ :global uhhUsageTick 0 }
:if ([:typeof $uhhUsageLastBody] != "str") do={ :global uhhUsageLastBody "" }
:set uhhUsageTick ($uhhUsageTick + 1)
:local addressOfMac do={
  :local ip ""
  :foreach h in=[/ip hotspot host find mac-address=$1] do={ :set ip [/ip hotspot host get $h address] }
  :if ($ip = "") do={
    :foreach a in=[/ip arp find mac-address=$1] do={ :set ip [/ip arp get $a address] }
  }
  :return $ip
}
:local postJson do={
  :global uhhBase
  :global uhhToken
  :global uhhTls
  :do {
    :local resp [/tool/fetch url=($uhhBase . $1) http-method=post http-header-field=("content-type:application/json,authorization:Bearer " . $uhhToken) http-data=$2 output=user as-value check-certificate=$uhhTls]
    :if (($resp->"status") = "finished") do={ :return true }
  } on-error={ :log warning ("uhh-usage: " . $1 . " rejected or unreachable") }
  :return false
}
:local stampNow ([/system clock get date] . " " . [/system clock get time])
:local samples ({})
:local sampleCap 500
:local keptMacs "|"
:local retireKeys "|"
:local instanceMacs "|"
:foreach r in=[/ip firewall mangle find comment~":up:"] do={
  :local c [/ip firewall mangle get $r comment]
  :local mac [:pick $c 10 27]
  :local epoch [:pick $c ([:find $c ":up:"] + 4) [:len $c]]
  :local ip [/ip firewall mangle get $r src-address]
  :local upBytes [/ip firewall mangle get $r bytes]
  :local downBytes 0
  :foreach d in=[/ip firewall mangle find comment=("uhh-usage:" . $mac . ":down:" . $epoch)] do={ :set downBytes [/ip firewall mangle get $d bytes] }
  :local bound ([:len [/ip hotspot ip-binding find type=bypassed mac-address=$mac]] > 0)
  :local curIp [$addressOfMac $mac]
  :local keep (($bound) && (($curIp = "") || ($curIp = $ip)))
  :set instanceMacs ($instanceMacs . $mac . "|")
  :if ([:len $samples] < $sampleCap) do={
    :set samples ($samples + {{"mac"=$mac; "ip"=$ip; "up_bytes"=$upBytes; "down_bytes"=$downBytes; "epoch"=$epoch}})
    :if ($keep) do={
      :set keptMacs ($keptMacs . $mac . "|")
    } else={
      :set retireKeys ($retireKeys . $mac . ":" . $epoch . "|")
    }
  } else={
    :set keptMacs ($keptMacs . $mac . "|")
  }
}
:local usageAccepted true
:if ([:len $samples] > 0) do={
  :local usageBody [:serialize to=json value={"router_id"=$uhhRouterId; "samples"=$samples}]
  :if ($usageBody != $uhhUsageLastBody) do={
    :set usageAccepted [$postJson "/api/router/usage" $usageBody]
    :if ($usageAccepted = true) do={ :global uhhUsageLastBody $usageBody }
  }
}
:local retainMacs $instanceMacs
:if ($usageAccepted = true) do={
  :foreach r in=[/ip firewall mangle find comment~":up:"] do={
    :local c [/ip firewall mangle get $r comment]
    :local mac [:pick $c 10 27]
    :local epoch [:pick $c ([:find $c ":up:"] + 4) [:len $c]]
    :if ([:typeof [:find $retireKeys ("|" . $mac . ":" . $epoch . "|")]] = "num") do={
      /ip firewall mangle remove [find comment=("uhh-usage:" . $mac . ":up:" . $epoch)]
      /ip firewall mangle remove [find comment=("uhh-usage:" . $mac . ":down:" . $epoch)]
      /ip firewall address-list remove [find list=uhh-usage-counted comment=("uhh-usage:" . $mac)]
    }
  }
  :set retainMacs $keptMacs
}
:foreach a in=[/ip firewall address-list find list=uhh-usage-counted] do={
  :local am [:pick [/ip firewall address-list get $a comment] 10 27]
  :if ([:typeof [:find $retainMacs ("|" . $am . "|")]] = "nil") do={ /ip firewall address-list remove $a }
}
:foreach b in=[/ip hotspot ip-binding find type=bypassed] do={
  :local bc [/ip hotspot ip-binding get $b comment]
  :if ([:pick $bc 0 4] = "uhh ") do={
    :local mac [/ip hotspot ip-binding get $b mac-address]
    :if ([:typeof [:find $retainMacs ("|" . $mac . "|")]] = "nil") do={
      :local ip [$addressOfMac $mac]
      :if ($ip != "") do={
        /ip firewall mangle add chain=prerouting action=passthrough src-address=$ip comment=("uhh-usage:" . $mac . ":up:" . $stampNow)
        /ip firewall mangle add chain=postrouting action=passthrough dst-address=$ip comment=("uhh-usage:" . $mac . ":down:" . $stampNow)
        /ip firewall address-list add list=uhh-usage-counted address=$ip comment=("uhh-usage:" . $mac)
        :set retainMacs ($retainMacs . $mac . "|")
      }
    }
  }
}
:local ftList ""
:if ([:len [/ip firewall address-list find list=uhh-usage-counted]] > 0) do={ :set ftList "!uhh-usage-counted" }
/ip firewall filter set [find comment="defconf: fasttrack"] src-address-list=$ftList dst-address-list=$ftList
:local heartbeatEvery ([:tonum $uhhHeartbeatIntervalS] / [:tonum $uhhUsageIntervalS])
:if ($heartbeatEvery < 1) do={ :set heartbeatEvery 1 }
:if ((($uhhUsageTick - 1) % $heartbeatEvery) = 0) do={
  :local wifiList ({})
  :foreach w in=[/interface wifi find] do={
    :local wifiName [/interface wifi get $w name]
    :set wifiList ($wifiList + {{"name"=$wifiName; "running"=[/interface wifi get $w running]; "clients"=[:len [/interface wifi registration-table find interface=$wifiName]]}})
  }
  :local etherList ({})
  :foreach e in=[/interface ethernet find] do={
    :set etherList ($etherList + {{"name"=[/interface ethernet get $e name]; "running"=[/interface ethernet get $e running]}})
  }
  :local registeredCount 0
  :foreach b in=[/ip hotspot ip-binding find] do={
    :if ([:pick [/ip hotspot ip-binding get $b comment] 0 4] = "uhh ") do={ :set registeredCount ($registeredCount + 1) }
  }
  :local lteRunning false
  :do { :set lteRunning [/interface lte get lte1 running] } on-error={}
  :local wanAddress ""
  :foreach a in=[/ip address find interface=wifi1 dynamic=yes] do={ :set wanAddress [/ip address get $a address] }
  :local slashAt [:find $wanAddress "/"]
  :if ([:typeof $slashAt] = "num") do={ :set wanAddress [:pick $wanAddress 0 $slashAt] }
  :local wanUp (([:len $wanAddress] > 0) && ([/interface wifi get [find default-name=wifi1] running] = true))
  :local logIds [/log find topics~"error"]
  :local logTotal [:len $logIds]
  :local logSeen 0
  :local logErrors ({})
  :foreach l in=$logIds do={
    :set logSeen ($logSeen + 1)
    :if ($logSeen > ($logTotal - 10)) do={
      :local line ([/log get $l time] . " " . [/log get $l message])
      :if ([:len $line] > 200) do={ :set line [:pick $line 0 200] }
      :set logErrors ($logErrors + {$line})
    }
  }
  :local versionText [/system resource get version]
  :local versionSpace [:find $versionText " "]
  :if ([:typeof $versionSpace] = "num") do={ :set versionText [:pick $versionText 0 $versionSpace] }
  :local health {"uptime_s"=[:tonum [/system resource get uptime]]; "version"=$versionText; "board"=[/system resource get board-name]; "cpu_load_pct"=[:tonum [/system resource get cpu-load]]; "free_mem_bytes"=[:tonum [/system resource get free-memory]]; "total_mem_bytes"=[:tonum [/system resource get total-memory]]; "active_clients"=[:len [/ip hotspot host find]]; "registered_devices"=$registeredCount; "bypassed_devices"=[:len [/ip hotspot ip-binding find type=bypassed]]; "wifi"=$wifiList; "ether"=$etherList; "lte"={"running"=$lteRunning}; "dhcp_leases"=[:len [/ip dhcp-server lease find]]; "wan"={"interface"="wifi1"; "address"=$wanAddress; "up"=$wanUp}; "config_version"=$uhhConfigVersion; "log_errors"=$logErrors}
  :foreach tn in={"board-temperature1";"cpu-temperature"} do={
    :if ([:len [/system health find name=$tn]] > 0) do={
      :if ([:typeof ($health->"temperature_c")] = "nil") do={ :set ($health->"temperature_c") [:tonum [/system health get [find name=$tn] value]] }
    }
  }
  :local heartbeatAccepted [$postJson "/api/router/heartbeat" [:serialize to=json value={"router_id"=$uhhRouterId; "health"=$health}]]
}
