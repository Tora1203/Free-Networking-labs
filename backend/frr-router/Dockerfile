# ルーター用イメージ（2026-10-14）。FRR公式イメージに、VLANサブインターフェースを
# vtyshの設定から自動で作るエージェント（fnl-subif-agent）を足したもの。詳細はREADME.md
#   fnl/frr:1（2026-10-14）：サブインターフェースのエージェント
#   fnl/frr:2（2026-10-14）：lldpd（LLDP/CDPv2を送り、スイッチの show lldp/cdp neighbors に出る）
#   fnl/frr:3（2026-10-15）：lldpdが送らなくなったら起動し直す（fnl-lldpd-start）
FROM quay.io/frrouting/frr:10.2.1
RUN apk add --no-cache lldpd
COPY fnl-subif-agent fnl-start fnl-lldpd-start /usr/local/bin/
RUN chmod 755 /usr/local/bin/fnl-subif-agent /usr/local/bin/fnl-start /usr/local/bin/fnl-lldpd-start
CMD ["/usr/local/bin/fnl-start"]
