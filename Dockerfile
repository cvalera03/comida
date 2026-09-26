# Imagen mínima: Python + librería estándar, sin dependencias externas.
FROM python:3.12-alpine

RUN apk add --no-cache su-exec tzdata \
 && addgroup -S -g 1000 comida && adduser -S -u 1000 -G comida comida

WORKDIR /app
COPY server.py docker-entrypoint.sh ./
COPY public ./public
RUN chmod +x docker-entrypoint.sh

ENV DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0 \
    PYTHONUNBUFFERED=1 \
    TZ=Europe/Madrid

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/api/health'%os.environ.get('PORT','8080'),timeout=4)"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["python", "server.py"]
