# 操作マニュアル（Markdown）をPDFにする道具。サーバーにWeasyPrintや日本語フォントを入れずに済むようにDockerで動かす。
#   docker build -t fnl/manual-build tools/manual
#   docker run --rm -v "$PWD/docs/manual:/work" fnl/manual-build
FROM alpine:3.22
RUN apk add --no-cache py3-markdown py3-pygments weasyprint font-noto-cjk font-noto-emoji ttf-dejavu
COPY build.py style.css /opt/manual/
WORKDIR /work
ENTRYPOINT ["python3", "/opt/manual/build.py"]
