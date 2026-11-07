:global uhhBase
:global uhhToken
:global uhhTls
:global uhhAdminUntil
:global uhhAdminNext
:if ([:typeof $uhhAdminUntil] != "num") do={ :global uhhAdminUntil 0 }
:if ([:typeof $uhhAdminNext] != "num") do={ :global uhhAdminNext 0 }
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
:local ifc [/interface wireguard find name=uhh-admin]
:if ([:len $ifc] = 0) do={ :error "uhh-admin: interface missing" }
:local nowE [$epochOf [/system clock get date] [/system clock get time]]
:local pub [/interface wireguard get $ifc public-key]
:local ttl -1
:local ep ""
:local hubPub ""
:local tip ""
:if ((([/interface wireguard get $ifc disabled]) = false) || ($nowE >= $uhhAdminNext)) do={
  :set uhhAdminNext ($nowE + 300)
  :do {
    :local r [/tool/fetch url=($uhhBase . "/api/router/admin?pub=" . $pub) http-method=get http-header-field=("authorization:Bearer " . $uhhToken) output=user as-value check-certificate=$uhhTls]
    :local d [:deserialize from=json value=[:tostr ($r->"data")]]
    :set ttl [:tonum ($d->"ttl_s")]
    :set ep [:tostr ($d->"endpoint")]
    :set hubPub [:tostr ($d->"hub_pub")]
    :set tip [:tostr ($d->"tunnel_ip")]
  } on-error={ :set ttl -1 }
}
:if ($ttl = 0) do={ :set uhhAdminUntil 0 }
:local colon [:find $ep ":"]
:if (($ttl > 0) && ($hubPub != "") && ($tip != "") && ([:typeof $colon] = "num")) do={
  :if ($ttl > 7200) do={ :set ttl 7200 }
  :set uhhAdminUntil ($nowE + $ttl)
  :local epHost [:pick $ep 0 $colon]
  :local epPort [:pick $ep ($colon + 1) [:len $ep]]
  :local peers [/interface wireguard peers find interface=uhh-admin]
  :if ([:len $peers] = 0) do={
    /interface wireguard peers add interface=uhh-admin public-key=$hubPub endpoint-address=$epHost endpoint-port=$epPort allowed-address=10.200.0.0/16 persistent-keepalive=25s comment=uhh-admin
  } else={
    :if (([/interface wireguard peers get $peers public-key] != $hubPub) || ([/interface wireguard peers get $peers endpoint-address] != $epHost) || ([/interface wireguard peers get $peers endpoint-port] != $epPort)) do={
      /interface wireguard peers set $peers public-key=$hubPub endpoint-address=$epHost endpoint-port=$epPort
    }
  }
  :if ([:len [/ip address find interface=uhh-admin]] = 0) do={ /ip address add address=($tip . "/16") interface=uhh-admin comment=uhh-admin }
  :if ([/interface wireguard get $ifc disabled] = true) do={
    /interface wireguard set $ifc disabled=no
    :log info "uhh-admin: window open"
  }
}
:if (($nowE >= $uhhAdminUntil) && ([/interface wireguard get $ifc disabled] = false)) do={
  /interface wireguard set $ifc disabled=yes
  :log info "uhh-admin: window closed"
}
