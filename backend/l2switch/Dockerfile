# Free-Networking-labs のL2スイッチ用イメージ（2026-10-13〜、ovs-bridgeからの置き換え）。
# 中身は alpine + iproute2 のみ。スイッチはこのコンテナ内のVLAN対応Linuxブリッジ（br0）で実現し、
# VLAN設定は `bridge vlan` をexecで投入する。理由と経緯は docs/direction.md（2026-10-13）参照。
FROM alpine:3.20
RUN apk add --no-cache iproute2
CMD ["sleep", "infinity"]
