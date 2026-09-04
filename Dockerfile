FROM python:3.11-slim

WORKDIR /app

# Certificado opcional de rede corporativa com inspeção SSL (ex.: proxy
# corporativo que faz MITM em HTTPS) — sem isso, chamadas HTTPS de dentro do
# container (Gemini, harus.ind.br) podem falhar com "self-signed certificate
# in certificate chain" nesse tipo de rede. O padrão `corporate-ca.cr[t]` é
# proposital: é um glob, então não quebra o build se o arquivo não existir
# (ele não está no repositório — é local e específico de cada rede). Se
# precisar, coloque seu certificado em `corporate-ca.crt` na raiz do projeto
# antes de buildar; caso contrário essa etapa só instala os certificados
# padrão e segue normalmente.
COPY corporate-ca.cr[t] /usr/local/share/ca-certificates/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-docker.txt .
RUN pip install --no-cache-dir -r requirements-docker.txt

COPY main.py rag.py executar_scrapers.py rag_indexer.py scraper_produtos_harus.py prompt.txt ./
COPY static ./static
COPY templates ./templates

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
