# Horizon Catalog

Addon de catálogo e metadados para **Stremio**, usando **TMDB** como fonte principal para:

- Filmes
- Séries
- Anime (animação japonesa via TMDB)
- Filmes de anime
- Busca
- Gêneros
- Temporadas, especiais e episódios
- IDs IMDb quando disponíveis, para melhorar compatibilidade com outros addons

> Este produto usa a API do TMDB, mas não é endossado nem certificado pelo TMDB.

## Requisitos

- Node.js 18 ou superior
- Uma chave **TMDB API v3**

O projeto não usa dependências npm externas. O `fetch` nativo do Node faz as chamadas ao TMDB.

## Rodar localmente

No Linux/macOS:

```bash
export TMDB_API_KEY="SUA_CHAVE_AQUI"
node server.js
```

No PowerShell:

```powershell
$env:TMDB_API_KEY="SUA_CHAVE_AQUI"
node server.js
```

Abra:

```text
http://localhost:7000/manifest.json
```

## Instalar no Stremio

Depois de hospedar o projeto em HTTPS, use:

```text
https://SEU-DOMINIO/manifest.json
```

## Deploy no Render

1. Suba esta pasta para um repositório.
2. No Render, crie um Web Service ou use o `render.yaml`.
3. Adicione a variável de ambiente `TMDB_API_KEY` com sua chave TMDB.
4. O comando de start é `node server.js`.
5. Quando o deploy terminar, instale `https://SEU-SERVICO.onrender.com/manifest.json` no Stremio.

## Variáveis de ambiente

| Variável | Padrão | Função |
|---|---:|---|
| `TMDB_API_KEY` | obrigatório | Chave TMDB API v3 |
| `PORT` | `7000` | Porta HTTP |
| `LANGUAGE` | `pt-BR` | Idioma dos metadados |
| `REGION` | `BR` | Região usada em filmes |
| `INCLUDE_SPECIALS` | `true` | Inclui Season 0 / especiais |
| `PREFER_IMDB_IDS` | `true` | Usa IDs IMDb quando o TMDB fornece |
| `CACHE_TTL_SECONDS` | `21600` | Cache padrão em memória |

## Como o anime é identificado

Sem AniList. O catálogo de anime usa apenas TMDB, combinando:

- gênero TMDB `Animation` (ID 16)
- idioma original japonês (`ja`)

Isso mantém a fonte única no TMDB. Consequência: algumas produções japonesas animadas podem entrar no catálogo e alguns animes com cadastro incomum no TMDB podem ficar de fora.

## Organização de temporadas

Para séries, o addon consulta as temporadas cadastradas no TMDB e converte cada episódio para o formato de `videos` do Stremio. Por padrão, `Season 0` também é carregada como especiais.

Quando existe IMDb ID da série, os episódios recebem IDs no formato:

```text
tt1234567:1:1
```

Isso costuma ser mais compatível com addons de stream que reconhecem o padrão IMDb + temporada + episódio.

## Rotas principais

```text
/manifest.json
/catalog/movie/tmdb-popular-movies.json
/catalog/series/tmdb-popular-series.json
/catalog/series/tmdb-anime.json
/catalog/movie/tmdb-anime-movies.json
/meta/movie/<id>.json
/meta/series/<id>.json
```

IDs aceitos pelo `meta`:

```text
tt1234567
tmdb:movie:550
tmdb:tv:1399
```

## Observações

O comportamento exato do protocolo Stremio e da API TMDB pode evoluir. Este projeto foi construído para o formato de addon amplamente usado pelo Stremio, mas vale validar em um deploy real antes de distribuir publicamente.
