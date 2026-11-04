:global uhhBase
:global uhhToken
:global uhhTls
/system script run uhh-config
:local body ""
:do {
  :local r [/tool/fetch url=($uhhBase . "/api/router/wa-prefixes") http-method=get http-header-field=("authorization:Bearer " . $uhhToken) output=user as-value check-certificate=$uhhTls]
  :if (($r->"status") = "finished") do={ :set body [:tostr ($r->"data")] }
} on-error={ :log warning "uhh-wa-refresh: fetch failed" }
:local total [:len $body]
:local n 0
:local pos 0
:while ($pos < $total) do={
  :local e [:find $body "\n" $pos]
  :if ([:typeof $e] != "num") do={ :set e $total }
  :local pf [:pick $body $pos $e]
  :if ([:len $pf] > 0 && [:typeof [:find $pf "/"]] = "num" && [:typeof [:find $pf ":"]] = "nil") do={ :set n ($n + 1) }
  :set pos ($e + 1)
}
:if ($n < 20) do={
  :log warning ("uhh-wa-refresh: only " . $n . " IPv4 prefixes, list kept")
} else={
  :set pos 0
  :while ($pos < $total) do={
    :local e [:find $body "\n" $pos]
    :if ([:typeof $e] != "num") do={ :set e $total }
    :local pf [:pick $body $pos $e]
    :if ([:len $pf] > 0 && [:typeof [:find $pf "/"]] = "num" && [:typeof [:find $pf ":"]] = "nil") do={
      :if ([:len [/ip firewall address-list find list=wa-ranges address=$pf]] = 0) do={
        /ip firewall address-list add list=wa-ranges address=$pf comment=uhh-wa
      }
    }
    :set pos ($e + 1)
  }
  :local listed ("\n" . $body . "\n")
  :foreach a in=[/ip firewall address-list find list=wa-ranges] do={
    :local addr [/ip firewall address-list get $a address]
    :if ([:typeof [:find $listed ("\n" . $addr . "\n")]] = "nil") do={ /ip firewall address-list remove $a }
  }
  :log info ("uhh-wa-refresh: " . $n . " IPv4 prefixes")
}
