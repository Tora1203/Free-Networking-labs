# L2スイッチ用イメージ。VLAN対応Linuxブリッジ（br0）＋Cisco風CLI（swcli）。詳細はREADME.md
#   fnl/l2switch:1（2026-10-13）：ブリッジのみ。VLANはGUIからexecでbridge vlanを投入
#   fnl/l2switch:2（2026-10-14）：swcliのrunning-configをエージェントがbr0に反映。GUIからのVLAN設定は廃止
FROM alpine:3.20
RUN apk add --no-cache iproute2 python3
COPY swcli.py /usr/local/bin/swcli
COPY fnl-switch-start /usr/local/bin/fnl-switch-start
RUN chmod 755 /usr/local/bin/swcli /usr/local/bin/fnl-switch-start
CMD ["/usr/local/bin/fnl-switch-start"]
