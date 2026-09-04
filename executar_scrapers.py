"""
Orquestrador do pipeline de ingestão: roda o scraper de produtos, resume o
resultado (X novos | Y atualizados | Z sem alteração) e, se algo mudou,
aciona a reindexação no Qdrant automaticamente.

Uso:
    python executar_scrapers.py                 # produtos + reindexação
    python executar_scrapers.py --teste          # roda rápido, poucos itens, sem reindexar
    python executar_scrapers.py --sem-reindexar  # roda o scraper mas não chama o indexador

Pensado pra ser chamado pelo N8N num agendamento diário (ver n8n/pipeline_diario.json).

Só um scraper por enquanto (produtos) — a estrutura com dict de stats e o
parâmetro `produtos=` foi mantida como no padrão FirstLab pra caber mais
fontes (ex.: um scraper de novidades/imprensa da Harus) sem redesenhar nada.
"""

import argparse

import scraper_produtos_harus
from rag_indexer import reindexar

LIMITE_TESTE = 10


def executar(produtos: bool = True, teste: bool = False, sem_reindexar: bool = False) -> dict:
    """
    Roda o pipeline completo (scraper + reindexação condicional) e devolve um
    resumo. Reutilizada tanto pela CLI (main) quanto pelo endpoint
    /admin/executar-pipeline do backend, que o N8N chama num agendamento diário.
    """
    limite = LIMITE_TESTE if teste else None

    stats_produtos = {"novos": 0, "atualizados": 0, "sem_alteracao": 0}

    if produtos:
        print("=" * 50)
        print("SCRAPER DE PRODUTOS (harus.ind.br)")
        print("=" * 50)
        stats_produtos = scraper_produtos_harus.main(limite=limite)

    print("=" * 50)
    print("RESUMO")
    print("=" * 50)
    print(f"Produtos: {stats_produtos['novos']} novos | {stats_produtos['atualizados']} atualizados | {stats_produtos['sem_alteracao']} sem alteração")

    houve_mudanca = stats_produtos["novos"] + stats_produtos["atualizados"] > 0
    resultado = {
        "produtos": stats_produtos,
        "total": stats_produtos,
        "reindexado": False,
    }

    if sem_reindexar or teste:
        print("\nReindexação pulada (sem_reindexar ou teste).")
        return resultado

    if not houve_mudanca:
        print("\nNenhum item novo/atualizado — reindexação não é necessária.")
        return resultado

    print("\nAcionando reindexação no Qdrant...")
    reindexar(produtos=produtos)
    resultado["reindexado"] = True
    return resultado


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--teste", action="store_true", help="roda rápido, processando poucos itens")
    parser.add_argument("--sem-reindexar", action="store_true", help="não chama o rag_indexer.py ao final")
    args = parser.parse_args()

    executar(produtos=True, teste=args.teste, sem_reindexar=args.sem_reindexar)


if __name__ == "__main__":
    main()
