:global uhhBase
:global uhhToken
:global uhhRouterId
:global uhhTls
:global uhhRegSeen
:local auth ("authorization:Bearer " . $uhhToken)
:local macOf do={
  :local mac ""
  :foreach h in=[/ip hotspot host find address=$1] do={ :set mac [/ip hotspot host get $h mac-address] }
  :if ($mac = "") do={
    :foreach a in=[/ip arp find address=$1] do={ :set mac [/ip arp get $a mac-address] }
  }
  :return $mac
}
:if ([:typeof $uhhRegSeen] != "str") do={
  :global uhhRegSeen ""
  :foreach e in=[/log find topics~"hotspot" message~": login failed"] do={
    :set uhhRegSeen ($uhhRegSeen . "|" . [:tostr $e] . "|")
  }
} else={
  :if ([:len $uhhRegSeen] > 4000) do={ :set uhhRegSeen "" }
  :foreach e in=[/log find topics~"hotspot" message~": login failed"] do={
    :local key ("|" . [:tostr $e] . "|")
    :if ([:typeof [:find $uhhRegSeen $key]] = "nil") do={
      :local msg [/log get $e message]
      :local open [:find $msg " ("]
      :local close [:find $msg "): login failed"]
      :if (([:typeof $open] = "num") && ([:typeof $close] = "num")) do={
        :local user [:pick $msg 0 $open]
        :local mac [$macOf [:pick $msg ($open + 2) $close]]
        :if ($mac = "") do={
          :log warning ("uhh-register: no MAC for " . $user)
          :set uhhRegSeen ($uhhRegSeen . $key)
        } else={
          :local ok false
          :do {
            :local r [/tool fetch url=($uhhBase . "/api/router/registration") http-method=post http-header-field=("content-type:application/json," . $auth) http-data=("{\"router_id\":\"" . $uhhRouterId . "\",\"mac\":\"" . $mac . "\",\"phone\":\"" . $user . "\"}") check-certificate=$uhhTls output=user as-value]
            :if (($r->"status") = "finished") do={ :set ok true }
          } on-error={ :log warning ("uhh-register: report for " . $user . " not sent, will retry") }
          :if ($ok = true) do={ :set uhhRegSeen ($uhhRegSeen . $key) }
        }
      }
    }
  }
}
