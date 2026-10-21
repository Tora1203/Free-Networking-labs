# L2スイッチ用イメージ。VLAN対応Linuxブリッジ（br0）＋Cisco風CLI（swcli）＋mstpd（STP/RSTP/MSTP）。詳細はREADME.md
#   fnl/l2switch:1（2026-10-13）：ブリッジのみ。VLANはGUIからexecでbridge vlanを投入
#   fnl/l2switch:2（2026-10-14）：swcliのrunning-configをエージェントがbr0に反映。GUIからのVLAN設定は廃止
#   fnl/l2switch:3（2026-10-14）：mstpdでSTP/RSTP/MSTP。カーネルのMST（mst_enabled）のためAlpine 3.22（iproute2 6.15）に
#   fnl/l2switch:4（2026-10-14）：GUIの「ケーブルを抜く」、非特権コンテナでのmstpdの修正
#   fnl/l2switch:5（2026-10-14）：ログ、show interfaces、MACテーブル、SVI・ping・パスワード、LLDP/CDP（lldpd）、EtherChannel、ポートセキュリティ
#   fnl/l2switch:6（2026-10-15）：コードレビュー（PR #22）の指摘を修正（Ctrl+Cで落ちない、STP設定の入れ直し、static MACの再試行ほか）

#   fnl/l2switch:7（2026-10-21）：swcliにプラグイン（l3.py）の拡張点を追加（L2スイッチの動きは変わらない）
#   fnl/l2switch:8（2026-10-21）：プラグインの拡張点を追加（routerモード、interface配下のFRR設定。L2スイッチの動きは変わらない）
#   fnl/l2switch:9（2026-10-21）：プラグインの拡張点を追加（route-mapモード。L2スイッチの動きは変わらない）

# mstpdはAlpineのパッケージに無いのでソースから作る。コンテナの中で動かすための改修はmstpd/fnl.patch
FROM alpine:3.22 AS mstpd
ARG MSTPD_COMMIT=2e747d80ad48ffd32ec2f918b48a7c7a3916253b
RUN apk add --no-cache build-base autoconf automake libtool linux-headers bsd-compat-headers pkgconf bash libmnl-dev git
RUN git clone https://github.com/mstpd/mstpd.git /src && git -C /src checkout "$MSTPD_COMMIT"
COPY mstpd/fnl.patch /src/fnl.patch
WORKDIR /src
RUN git apply fnl.patch \
 && ./autogen.sh && ./configure --prefix=/usr --sysconfdir=/etc --sbindir=/usr/sbin \
 && make -j"$(nproc)" && make install DESTDIR=/out

FROM alpine:3.22
RUN apk add --no-cache iproute2 iproute2-tc python3 libmnl lldpd
COPY --from=mstpd /out/usr/sbin/mstpd /out/usr/sbin/mstpctl /usr/sbin/
COPY swcli.py /usr/local/bin/swcli
COPY fnl-switch-start /usr/local/bin/fnl-switch-start
RUN chmod 755 /usr/local/bin/swcli /usr/local/bin/fnl-switch-start
CMD ["/usr/local/bin/fnl-switch-start"]
