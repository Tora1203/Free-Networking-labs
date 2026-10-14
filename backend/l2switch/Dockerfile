# L2スイッチ用イメージ。VLAN対応Linuxブリッジ（br0）＋Cisco風CLI（swcli）＋mstpd（STP/RSTP/MSTP）。詳細はREADME.md
#   fnl/l2switch:1（2026-10-13）：ブリッジのみ。VLANはGUIからexecでbridge vlanを投入
#   fnl/l2switch:2（2026-10-14）：swcliのrunning-configをエージェントがbr0に反映。GUIからのVLAN設定は廃止
#   fnl/l2switch:3（2026-10-14）：mstpdでSTP/RSTP/MSTP。カーネルのMST（mst_enabled）のためAlpine 3.22（iproute2 6.15）に

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
RUN apk add --no-cache iproute2 iproute2-tc python3 libmnl
COPY --from=mstpd /out/usr/sbin/mstpd /out/usr/sbin/mstpctl /usr/sbin/
COPY swcli.py /usr/local/bin/swcli
COPY fnl-switch-start /usr/local/bin/fnl-switch-start
RUN chmod 755 /usr/local/bin/swcli /usr/local/bin/fnl-switch-start
CMD ["/usr/local/bin/fnl-switch-start"]
