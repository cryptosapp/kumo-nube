"""Mercados de predicción de Hyperliquid (HIP-4, «outcome markets»).

En la cuenta aparecen como saldos «+N», donde N = 10 × id_del_mercado + lado
(0 = primer lado, normalmente «Sí»; 1 = el segundo, normalmente «No»). Valen entre
0 y 1 USDC y al vencer pagan 1 por unidad si aciertas y 0 si no.

Kumo no opera estos mercados: solo los separa de tus monedas (para que la
estrategia no intente comprarlos o venderlos), les pone nombre legible y los
valora con el precio medio del libro (allMids usa la forma «#N»).
"""
import re
from datetime import datetime, timezone

PATRON = re.compile(r"^\+(\d+)$")
TRADUCE = {"Yes": "Sí", "No": "No"}


def es_prediccion(coin):
    return bool(PATRON.match(str(coin)))


def separar(saldos):
    """({moneda: cant} sin predicciones, {"+N": cant})."""
    normales, preds = {}, {}
    for k, v in saldos.items():
        (preds if es_prediccion(k) else normales)[k] = v
    return normales, preds


def _campos(desc):
    out = {}
    for parte in str(desc or "").split("|"):
        if ":" in parte:
            k, v = parte.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def _vence_ms(texto):
    try:
        return int(datetime.strptime(texto, "%Y%m%d-%H%M").replace(tzinfo=timezone.utc).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _pregunta(o, preguntas):
    """Texto legible del mercado."""
    c = _campos(o.get("description"))
    if c.get("class") == "priceBinary" and c.get("underlying"):
        tp = _num(c.get("targetPrice"))
        precio = f"{tp:,.6g}".replace(",", " ") if tp is not None else c.get("targetPrice", "?")
        return f"¿{c['underlying']} ≥ {precio} al vencer?"
    q = preguntas.get(o.get("outcome"))
    if c.get("participant"):
        comp = _campos(q.get("description")).get("competition") if q else None
        return f"¿{c['participant']} gana{(' ' + comp) if comp else ''}?"
    nombre = re.sub(r"^template:", "", str(o.get("name") or "")).strip()
    return nombre or f"Mercado {o.get('outcome')}"


def describir(preds, info):
    """Lista de predicciones con nombre, lado, precio y valor.
    `info(cuerpo)` hace POST a https://api.hyperliquid.xyz/info."""
    if not preds:
        return []
    try:
        meta = info({"type": "outcomeMeta"}) or {}
        mids = info({"type": "allMids"}) or {}
    except Exception:  # sin red: se muestran sin precio
        meta, mids = {}, {}
    mercados = {o.get("outcome"): o for o in meta.get("outcomes") or []}
    preguntas = {}
    for q in meta.get("questions") or []:
        for n in (q.get("namedOutcomes") or []) + [q.get("fallbackOutcome")]:
            preguntas[n] = q
    out = []
    for coin, cant in sorted(preds.items()):
        cod = int(PATRON.match(coin).group(1))
        oid, lado = divmod(cod, 10)
        o = mercados.get(oid) or {}
        lados = [s.get("name") for s in o.get("sideSpecs") or []]
        c = _campos(o.get("description"))
        precio = _num(mids.get(f"#{cod}"))
        out.append({
            "coin": coin, "mercado": oid, "lado": lado,
            "lado_nombre": TRADUCE.get(lados[lado], lados[lado]) if lado < len(lados) else ("Sí" if lado == 0 else "No"),
            "pregunta": _pregunta(o, preguntas) if o else f"Mercado {oid}",
            "cantidad": cant, "precio": precio,
            "valor": round(cant * precio, 2) if precio is not None else None,
            "pago_si_acierta": round(cant, 2),
            "vence": _vence_ms(c.get("expiry")) or _vence_ms(_campos((preguntas.get(oid) or {}).get("description")).get("resolutionDeadline")),
            "quote": o.get("quoteToken") or "USDC",
            # Para que la IA compare el precio actual con el objetivo (mercados de precio).
            "subyacente": c.get("underlying") if c.get("class") == "priceBinary" else None,
            "objetivo": _num(c.get("targetPrice")) if c.get("class") == "priceBinary" else None,
        })
    return out
