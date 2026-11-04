:global uhhBase
:global uhhToken
:global uhhRouterId
:global uhhHost
:global uhhPortalHost
:global uhhTls
:global uhhGuestSsid
:global uhhWalledGarden
:global uhhUsageIntervalS
/system script run uhh-config
:if ([:typeof $uhhGuestSsid] != "str") do={ :global uhhGuestSsid "Ubuntu Herd Health" }
:if ([:len $uhhGuestSsid] = 0) do={ :global uhhGuestSsid "Ubuntu Herd Health" }
:if ([:typeof $uhhWalledGarden] != "array") do={ :global uhhWalledGarden {"whatsapp.com";"*.whatsapp.com";"whatsapp.net";"*.whatsapp.net";"wa.me";"*.wa.me"} }
:if ([:typeof $uhhUsageIntervalS] != "num") do={ :global uhhUsageIntervalS 300 }
:if ([:typeof $uhhHost] != "str") do={ :global uhhHost "ubuntudashboard.co.za" }
:if ([:typeof $uhhPortalHost] != "str") do={ :global uhhPortalHost "portal.ubuntudashboard.co.za" }
:if ([:typeof $uhhTls] != "str") do={ :global uhhTls "yes-without-crl" }

/system clock set time-zone-autodetect=no time-zone-name=Africa/Johannesburg

:if ([:len [/interface bridge find name=mgmt]] = 0) do={
  :if ([:len [/interface bridge find name=bridge]] > 0) do={ /interface bridge set [find name=bridge] name=mgmt comment=defconf } else={ /interface bridge add name=mgmt comment=defconf }
}
:if ([:len [/interface bridge find name=guest]] = 0) do={ /interface bridge add name=guest comment=uhh-guest }
:foreach p in=[/interface bridge port find bridge=mgmt] do={
  :if ([/interface bridge port get $p interface] != "ether1") do={ /interface bridge port remove $p }
}
:if ([:len [/interface bridge port find bridge=mgmt interface=ether1]] = 0) do={ /interface bridge port add bridge=mgmt interface=ether1 comment=defconf }
:if ([:len [/interface bridge port find bridge=guest interface=ether2]] = 0) do={ /interface bridge port add bridge=guest interface=ether2 comment=uhh-guest }

:if ([:len [/interface wifi datapath find name=uhh-guest-dp]] = 0) do={ /interface wifi datapath add name=uhh-guest-dp bridge=guest comment=uhh-guest }
/interface wifi set [find default-name=wifi2] channel.band=5ghz-ax channel.skip-dfs-channels=all channel.width=20/40mhz configuration.country="South Africa" configuration.mode=ap configuration.ssid=$uhhGuestSsid datapath=uhh-guest-dp disabled=no security.authentication-types="" security.ft=yes security.ft-over-ds=yes

:if ([:len [/interface list find name=LAN]] = 0) do={ /interface list add name=LAN comment=defconf }
:if ([:len [/interface list find name=WAN]] = 0) do={ /interface list add name=WAN comment=defconf }
:if ([:len [/interface list find name=GUEST]] = 0) do={ /interface list add name=GUEST }
:if ([:len [/interface list member find interface=mgmt list=LAN]] = 0) do={ /interface list member add interface=mgmt list=LAN comment=defconf }
:if ([:len [/interface list member find interface=guest list=GUEST]] = 0) do={ /interface list member add interface=guest list=GUEST }
:foreach i in={"wifi1";"lte1"} do={
  :if (([:len [/interface find name=$i]] > 0) && ([:len [/interface list member find interface=$i list=WAN]] = 0)) do={ /interface list member add interface=$i list=WAN comment=defconf }
}

:if ([:len [/ip address find address="192.168.88.1/24"]] = 0) do={ /ip address add address=192.168.88.1/24 interface=mgmt network=192.168.88.0 comment=defconf }
:if ([:len [/ip address find address="10.10.10.1/24"]] = 0) do={ /ip address add address=10.10.10.1/24 interface=guest network=10.10.10.0 comment=uhh-guest }
:if ([:len [/ip dhcp-client find interface=wifi1]] = 0) do={ /ip dhcp-client add interface=wifi1 }

:if ([:len [/ip pool find name=guest-pool]] = 0) do={ /ip pool add name=guest-pool ranges=10.10.10.10-10.10.10.254 }
:if ([:len [/ip dhcp-server find name=guest-dhcp]] = 0) do={ /ip dhcp-server add name=guest-dhcp interface=guest address-pool=guest-pool disabled=no }
:if ([:len [/ip dhcp-server network find address="10.10.10.0/24"]] = 0) do={ /ip dhcp-server network add address=10.10.10.0/24 gateway=10.10.10.1 dns-server=10.10.10.1 comment=uhh-guest }
/ip dns set allow-remote-requests=yes
:if ([:len [/ip dns static find name=$uhhPortalHost comment=uhh-portal]] = 0) do={ /ip dns static add name=$uhhPortalHost address=10.10.10.1 comment=uhh-portal }

:if ([:len [/ip hotspot profile find name=uhh-portal]] = 0) do={ /ip hotspot profile add name=uhh-portal }
:local hsCert "uhh-hs"
:if ([:len [/certificate find name=uhh-portal]] > 0) do={ :set hsCert "uhh-portal" }
/ip hotspot profile set [find name=uhh-portal] html-directory=hotspot login-by=cookie,https ssl-certificate=$hsCert dns-name=$uhhPortalHost use-radius=no
:if ([:len [/ip hotspot find name=uhh-hotspot]] = 0) do={ /ip hotspot add name=uhh-hotspot interface=guest profile=uhh-portal disabled=no }
/ip hotspot set [find name=uhh-hotspot] interface=guest profile=uhh-portal disabled=no
/ip hotspot walled-garden remove [find comment=uhh-portal]
:foreach w in=$uhhWalledGarden do={ /ip hotspot walled-garden add dst-host=$w action=allow comment=uhh-portal }

:if ([:len [/certificate find name=uhh-hs-ca]] = 0) do={
  /certificate add name=uhh-hs-ca common-name=uhh-hotspot-ca key-usage=key-cert-sign,crl-sign days-valid=3650 key-size=2048 digest-algorithm=sha256
  /certificate sign uhh-hs-ca
}
/certificate set [find name=uhh-hs-ca] trusted=yes
:if ([:len [/certificate find name=uhh-hs]] = 0) do={
  /certificate add name=uhh-hs common-name=10.10.10.1 key-usage=digital-signature,key-encipherment,tls-server days-valid=3650 key-size=2048 digest-algorithm=sha256
  /certificate sign uhh-hs ca=uhh-hs-ca
}
:if ([:len [/certificate find common-name="ISRG Root X2"]] = 0) do={
  :if ([:len [/file find name="isrg-root-x2.pem"]] > 0) do={
    /certificate import file-name=isrg-root-x2.pem passphrase=""
    /file remove [find name="isrg-root-x2.pem"]
  }
}
:if ([:len [/certificate find common-name="ISRG Root X2"]] > 0) do={ /certificate set [find common-name="ISRG Root X2"] trusted=yes }

/ip service set ftp disabled=yes
/ip service set telnet disabled=yes
/ip service set ssh address=192.168.88.0/24
/ip service set www address=192.168.88.0/24
/ip service set winbox address=192.168.88.0/24
/ip service set api address=192.168.88.0/24
/ip service set api-ssl address=192.168.88.0/24
/ip service set www-ssl address=192.168.88.0/24 certificate=uhh-hs

:foreach c in={"uhh:f-dns-u";"uhh:f-dns-t";"uhh:f-uhh";"uhh:f-wa-t";"uhh:f-wa-u";"uhh:f-drop";"uhh:i-dns-dhcp";"uhh:i-dns-t";"uhh:i-hs";"uhh:i-drop"} do={
  /ip firewall filter remove [find comment=$c]
}
:local inA [/ip firewall filter find comment="defconf: drop all not coming from LAN"]
:local fwA [/ip firewall filter find comment="defconf: accept in ipsec policy"]
:if (([:len $inA] = 0) || ([:len $fwA] = 0)) do={ :error "uhh-portal: firewall anchors missing" }
/ip firewall filter add chain=input in-interface=guest protocol=udp dst-port=53,67 action=accept comment=uhh:i-dns-dhcp place-before=$inA
/ip firewall filter add chain=input in-interface=guest protocol=tcp dst-port=53 action=accept comment=uhh:i-dns-t place-before=$inA
/ip firewall filter add chain=input in-interface=guest protocol=tcp dst-port=64872-64875 action=accept comment=uhh:i-hs place-before=$inA
/ip firewall filter add chain=input in-interface=guest action=drop comment=uhh:i-drop place-before=$inA
/ip firewall filter add chain=forward in-interface=guest protocol=tcp dst-address-list=wa-ranges dst-port=443,5222,5223,4244 action=accept comment=uhh:f-wa-t place-before=$fwA
/ip firewall filter add chain=forward in-interface=guest protocol=udp dst-address-list=wa-ranges dst-port=443,3478-3481 action=accept comment=uhh:f-wa-u place-before=$fwA
/ip firewall filter add chain=forward in-interface=guest action=drop comment=uhh:f-drop place-before=$fwA
:if ([:len [/ip firewall nat find comment=uhh:n-passed-http]] = 0) do={ /ip firewall nat add chain=dstnat in-interface=guest protocol=tcp dst-port=80 hotspot=auth dst-address=!10.10.10.1 action=dst-nat to-addresses=10.10.10.1 to-ports=80 comment=uhh:n-passed-http }


:foreach s in={"uhh-gate";"uhh-usage";"uhh-sync";"uhh-wa-refresh";"uhh-tls"} do={
  :local src [/file get [find name=($s . ".rsc")] contents]
  :if ([:len [/system script find name=$s]] = 0) do={ /system script add name=$s owner=admin policy=ftp,read,write,policy,test,sensitive source="" }
  /system script set [find name=$s] source=$src policy=ftp,read,write,policy,test,sensitive
}

:if ([:len [/system scheduler find name=uhh-wa-refresh]] = 0) do={ /system scheduler add name=uhh-wa-refresh interval=1d start-time=03:17:00 on-event="/system script run uhh-wa-refresh" policy=ftp,read,write,policy,test,sensitive }
:if ([:len [/system scheduler find name=uhh-gate]] = 0) do={ /system scheduler add name=uhh-gate interval=1m start-time=startup on-event="/system script run uhh-gate" policy=ftp,read,write,policy,test,sensitive }
:if ([:len [/system scheduler find name=uhh-sync]] = 0) do={ /system scheduler add name=uhh-sync interval=5m start-time=startup on-event="/system script run uhh-sync" policy=ftp,read,write,policy,test,sensitive }
:if ([:len [/system scheduler find name=uhh-usage]] = 0) do={ /system scheduler add name=uhh-usage interval=($uhhUsageIntervalS . "s") start-time=startup on-event="/system script run uhh-usage" policy=ftp,read,write,policy,test,sensitive }
:if ([:len [/system scheduler find name=uhh-tls]] = 0) do={ /system scheduler add name=uhh-tls interval=1d start-time=04:11:00 on-event="/system script run uhh-tls" policy=ftp,read,write,policy,test,sensitive }
:foreach sc in={"uhh-gate";"uhh-usage";"uhh-sync";"uhh-wa-refresh";"uhh-tls"} do={ /system scheduler set [find name=$sc] policy=ftp,read,write,policy,test,sensitive }

:if ([:len [/interface bridge port find bridge=guest interface=ether2]] = 0) do={ :error "uhh-portal: guest port missing" }
:if ([:len [/interface wifi datapath find name=uhh-guest-dp]] = 0) do={ :error "uhh-portal: guest datapath missing" }
:if ([:len [/ip hotspot find name=uhh-hotspot]] = 0) do={ :error "uhh-portal: hotspot missing" }
/system script run uhh-sync
/system script run uhh-tls
:log info "uhh-portal: applied"
