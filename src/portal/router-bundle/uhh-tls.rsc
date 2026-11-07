:global uhhBase
:global uhhToken
:global uhhPortalHost
:if ([:typeof $uhhPortalHost] != "str") do={ :global uhhPortalHost "www.ubuntudashboard.co.za" }
:local auth ("Authorization: Bearer " . $uhhToken)
:local base ($uhhBase . "/api/router/bundle/")
:local fetched 0
:foreach f in={"portal-cert.pem";"portal-key.pem"} do={
  :do {
    /tool fetch url=($base . $f) dst-path=($f . ".new") check-certificate=yes-without-crl http-header-field=$auth
    :set fetched ($fetched + 1)
  } on-error={ :log info ("uhh-tls: " . $f . " not offered") }
}
:if ($fetched = 2) do={
  :local same true
  :foreach f in={"portal-cert.pem";"portal-key.pem"} do={
    :if ([:len [/file find name=$f]] = 0 || [/file get [find name=$f] contents] != [/file get [find name=($f . ".new")] contents]) do={ :set same false }
  }
  :if ($same) do={
    :foreach f in={"portal-cert.pem";"portal-key.pem"} do={ /file remove [find name=($f . ".new")] }
  } else={
    :foreach f in={"portal-cert.pem";"portal-key.pem"} do={
      :if ([:len [/file find name=$f]] > 0) do={ /file remove [find name=$f] }
      /file set [find name=($f . ".new")] name=$f
    }
    :if ([:len [/certificate find name=uhh-portal]] > 0) do={ /certificate remove [find name=uhh-portal] }
    /certificate remove [find name~"^portal-cert.pem_"]
    /certificate import file-name=portal-cert.pem passphrase=""
    /certificate import file-name=portal-key.pem passphrase=""
    /certificate set [find common-name=$uhhPortalHost] name=uhh-portal
    /ip hotspot profile set [find name=uhh-portal] ssl-certificate=uhh-portal
    :log info "uhh-tls: portal certificate installed"
  }
}
