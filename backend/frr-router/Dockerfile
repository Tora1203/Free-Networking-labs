# ルーター用イメージ（2026-10-14）。FRR公式イメージに、VLANサブインターフェースを
# vtyshの設定から自動で作るエージェント（fnl-subif-agent）を足しただけのもの。詳細はREADME.md
FROM quay.io/frrouting/frr:10.2.1
COPY fnl-subif-agent fnl-start /usr/local/bin/
RUN chmod 755 /usr/local/bin/fnl-subif-agent /usr/local/bin/fnl-start
CMD ["/usr/local/bin/fnl-start"]
