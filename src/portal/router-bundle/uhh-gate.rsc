:global uhhBase
:global uhhToken
:global uhhRouterId
:global uhhTls
:global uhhContactWindowS
:global uhhIdleTimeoutS
:global uhhBlockS
:global portalRes
/system script run uhh-config
:if (([:typeof [:find $uhhBase "https://"]] != "num") || ([:typeof [:find $uhhToken "__"]] = "num") || ([:typeof [:find $uhhRouterId "__"]] = "num")) do={ :log error "uhh-gate: uhh-config incomplete"; :error "uhh-gate: config" }
:local epochOf do={
  :local yy [:tonum [:pick $1 0 4]]
  :local mm [:tonum [:pick $1 5 7]]
  :local dd [:tonum [:pick $1 8 10]]
  :if ($mm <= 2) do={ :set yy ($yy - 1) }
  :local era ($yy / 400)
  :local yoe ($yy - $era * 400)
  :local mp (($mm + 9) % 12)
  :local doy ((153 * $mp + 2) / 5 + $dd - 1)
  :local doe ($yoe * 365 + $yoe / 4 - $yoe / 100 + $doy)
  :local days ($era * 146097 + $doe - 719468)
  :return ($days * 86400 + [:tonum [:totime $2]])
}
:local isoStamp do={
  :local off [:tonum [/system clock get gmt-offset]]
  :local sign "+"
  :if ($off < 0) do={ :set sign "-"; :set off (0 - $off) }
  :local oh ("0" . [:tostr ($off / 3600)])
  :local om ("0" . [:tostr (($off % 3600) / 60)])
  :return ($1 . "T" . $2 . $sign . [:pick $oh ([:len $oh] - 2) [:len $oh]] . ":" . [:pick $om ([:len $om] - 2) [:len $om]])
}
:local postEvent do={
  :global uhhBase
  :global uhhToken
  :global uhhRouterId
  :global uhhTls
  :local macPart ""
  :if ([:len $2] > 0) do={ :set macPart (",\"mac\":\"" . $2 . "\"") }
  :local detailPart ""
  :if ([:len $3] > 0) do={ :set detailPart (",\"detail\":" . $3) }
  :local body ("{\"router_id\":\"" . $uhhRouterId . "\",\"events\":[{\"ts\":\"" . $4 . "\",\"type\":\"" . $1 . "\"" . $macPart . $detailPart . "}]}")
  :do {
    /tool/fetch url=($uhhBase . "/api/router/events") http-method=post http-header-field=("content-type:application/json,authorization:Bearer " . $uhhToken) http-data=$body output=none check-certificate=$uhhTls
  } on-error={ :log warning ("uhh-gate: event " . $1 . " rejected or unreachable") }
}
:local poll do={
  :global uhhBase
  :global uhhToken
  :global uhhTls
  :global portalRes
  :set portalRes "err"
  :do {
    :local r [/tool/fetch url=($uhhBase . "/api/router/status?mac=" . $1) http-method=get http-header-field=("authorization:Bearer " . $uhhToken) output=user as-value check-certificate=$uhhTls]
    :local hs [:tostr ($r->"http-status")]
    :if ((($r->"status") = "finished") && (($hs = "") || ($hs = "200"))) do={
      :local d [:deserialize from=json value=[:tostr ($r->"data")]]
      :local reg [:tostr ($d->"registered")]
      :local con [:tostr ($d->"contacted")]
      :if ($reg = "true") do={
        :set portalRes "reg0"
        :if ($con = "true") do={ :set portalRes "reg1" }
      }
      :if ($reg = "false") do={ :set portalRes "unreg" }
    }
  } on-error={ :log warning ("uhh-gate: status failed for " . $1) }
}
:local dropconn do={
  :if ($1 != "") do={
    :foreach cn in=[/ip firewall connection find] do={
      :if ([:find [/ip firewall connection get $cn src-address] ($1 . ":")] = 0) do={ /ip firewall connection remove $cn }
    }
  }
}
:local nowD [/system clock get date]
:local nowT [/system clock get time]
:local nowE [$epochOf $nowD $nowT]
:local eventTs [$isoStamp $nowD $nowT]
:local act "|"
:foreach cn in=[/ip firewall connection find] do={
  :local s [/ip firewall connection get $cn src-address]
  :local p [:find $s ":"]
  :if ([:typeof $p] = "num") do={ :set act ($act . [:pick $s 0 $p] . "|") }
}
:foreach b in=[/ip hotspot ip-binding find] do={
  :local bt [/ip hotspot ip-binding get $b type]
  :local bc [/ip hotspot ip-binding get $b comment]
  :if ([:pick $bc 0 4] = "uhh ") do={
    :local mac [/ip hotspot ip-binding get $b mac-address]
    :local ip ""
    :do { :set ip [/ip hotspot host get [find mac-address=$mac] address] } on-error={}
    :local regD [:pick $bc 4 14]
    :local regT [:pick $bc 15 23]
    :local st [:pick $bc 24 28]
    :local lastD [:pick $bc 29 39]
    :local lastT [:pick $bc 40 48]
    :local regE [$epochOf $regD $regT]
    :local lastE [$epochOf $lastD $lastT]
    :local active false
    :if ([:typeof [:find $act ("|" . $ip . "|")]] = "num") do={ :set active true }
    :if ($bt = "blocked") do={
      :if (($nowE - $regE) >= $uhhBlockS) do={ /ip hotspot ip-binding remove $b }
    }
    :if (($bt = "bypassed") && ($st = "pend")) do={
      :local waited ($nowE - $regE)
      :if (($waited >= $uhhContactWindowS) || ($waited < 0)) do={
        $poll $mac
        :if ($portalRes = "reg1") do={
          /ip hotspot ip-binding set $b comment=("uhh " . $regD . " " . $regT . " pass " . $nowD . " " . $nowT)
          $postEvent "check_pass" $mac "" $eventTs
        }
        :if (($portalRes = "reg0") || ($portalRes = "unreg")) do={
          /ip hotspot ip-binding remove $b
          $dropconn $ip
          /ip hotspot ip-binding add type=blocked mac-address=$mac comment=("uhh " . $nowD . " " . $nowT . " blck " . $nowD . " " . $nowT)
          $postEvent "cutoff" $mac "" $eventTs
          $postEvent "block" $mac ("{\"block_s\":" . $uhhBlockS . "}") $eventTs
        }
      }
    }
    :if (($bt = "bypassed") && ($st = "pass")) do={
      :local sinceSeen ($nowE - $lastE)
      :if ($active) do={
        :if (($sinceSeen >= 300) || ($sinceSeen < 0)) do={
          /ip hotspot ip-binding set $b comment=("uhh " . $regD . " " . $regT . " pass " . $nowD . " " . $nowT)
        }
      } else={
        :if (($sinceSeen >= $uhhIdleTimeoutS) || ($sinceSeen < 0)) do={
          /ip hotspot ip-binding remove $b
          $dropconn $ip
        }
      }
    }
  }
}
:local budget 10
:foreach h in=[/ip hotspot host find] do={
  :if ($budget > 0) do={
    :local mac ""
    :local ip ""
    :do { :set mac [/ip hotspot host get $h mac-address]; :set ip [/ip hotspot host get $h address] } on-error={}
    :if (($mac != "") && ([:len [/ip hotspot ip-binding find mac-address=$mac]] = 0) && ([:typeof [:find $act ("|" . $ip . "|")]] = "num")) do={
      :set budget ($budget - 1)
      $poll $mac
      :if (($portalRes = "reg0") || ($portalRes = "reg1")) do={
        :local st "pend"
        :if ($portalRes = "reg1") do={ :set st "pass" }
        /ip hotspot ip-binding add type=bypassed mac-address=$mac comment=("uhh " . $nowD . " " . $nowT . " " . $st . " " . $nowD . " " . $nowT)
        $postEvent "login" $mac ("{\"ip\":\"" . $ip . "\"}") $eventTs
      }
    }
  }
}
