:global uhhBase
:global uhhToken
:global uhhRouterId
:global uhhTls
:global uhhRegSeen
:local auth ("Authorization: Bearer " . $uhhToken)
:if ([:typeof $uhhRegSeen] != "str") do={
  :global uhhRegSeen ""
  :foreach e in=[/log find topics~"hotspot" message~"login failed for: "] do={
    :set uhhRegSeen ($uhhRegSeen . "|" . [:tostr $e] . "|")
  }
} else={
  :if ([:len $uhhRegSeen] > 4000) do={ :set uhhRegSeen "" }
  :foreach e in=[/log find topics~"hotspot" message~"login failed for: "] do={
    :local key ("|" . [:tostr $e] . "|")
    :if ([:typeof [:find $uhhRegSeen $key]] = "nil") do={
      :set uhhRegSeen ($uhhRegSeen . $key)
      :do {
        :local msg [/log get $e message]
        :local start ([:find $msg "login failed for: "] + 19)
        :local rest [:pick $msg $start [:len $msg]]
        :local sp [:find $rest " from "]
        :if ([:typeof $sp] = "num") do={
          :local user [:pick $rest 0 $sp]
          :local mac [:pick $rest ($sp + 6) ($sp + 23)]
          /tool fetch url=($uhhBase . "/api/router/registration") http-method=post http-header-field=("Content-Type: application/json," . $auth) http-data=("{\"router_id\":\"" . $uhhRouterId . "\",\"mac\":\"" . $mac . "\",\"phone\":\"" . $user . "\"}") check-certificate=$uhhTls output=none
        }
      } on-error={ :log warning "uhh-register: could not report a hotspot login" }
    }
  }
}
