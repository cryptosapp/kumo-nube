"""Mercados de predicción de Hyperliquid (HIP-4, «outcome markets»).

En la cuenta aparecen como saldos «+N», donde N = 10 × id_del_mercado + lado
(0 = primer lado, normalmente «Sí»; 1 = el segundo, normalmente «No»). Valen entre
0 y 1 USDC y al vencer pagan 1 por unidad si aciertas y 0 si no.

La estrategia de monedas nunca los toca: aquí se separan de tus monedas, se les
pone nombre legible y se valoran con el precio medio del libro (allMids usa la
forma «#N»). En la beta, además, cada ciclo la IA revisa los mercados de precio
(«¿SOL ≥ 120 al vencer?») y tus posiciones, y propone (o ejecuta, si lo activas)
órdenes: ver `mercados` y `proponer`.
"""
import math
import re
import time
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


# ---------------------------------------------------------------- IA en cada ciclo (beta)
def _normal(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def prob_modelo(ahora, objetivo, sigma_h, horas):
    """Probabilidad de terminar ≥ objetivo (log-normal con la volatilidad por hora
    de las últimas 48 h). Es una referencia, no una certeza. Igual que en la nube."""
    if not (ahora and objetivo and sigma_h and horas) or min(ahora, objetivo, sigma_h, horas) <= 0:
        return None
    s = sigma_h * math.sqrt(horas)
    return _normal((math.log(ahora / objetivo) - s * s / 2) / s)


def _volatilidad(info, sub, ahora_ms):
    velas = info({"type": "candleSnapshot", "req": {"coin": sub, "interval": "1h", "startTime": ahora_ms - 48 * 3_600_000, "endTime": ahora_ms}}) or []
    c = [x for x in (_num(v.get("c")) for v in velas) if x and x > 0]
    if len(c) < 6:
        return None
    r = [math.log(b / a) for a, b in zip(c, c[1:])]
    m = sum(r) / len(r)
    return {"sigma_h": math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1)),
            "cambio_24h_pct": round((c[-1] / c[-25] - 1) * 100, 2) if len(c) > 24 else None}


def mercados(info, ahora_ms=None, horas_min=1.0, horas_max=36.0, max_subyacentes=8):
    """Mercados de precio abiertos que vencen entre `horas_min` y `horas_max`, con la
    probabilidad del modelo y la «ventaja» (puntos) de cada lado: modelo − mercado."""
    ahora_ms = ahora_ms or int(time.time() * 1000)
    meta = info({"type": "outcomeMeta"}) or {}
    mids = info({"type": "allMids"}) or {}
    out, vols = [], {}
    for o in meta.get("outcomes") or []:
        c = _campos(o.get("description"))
        if c.get("class") != "priceBinary" or not c.get("underlying"):
            continue
        vence, objetivo, sub = _vence_ms(c.get("expiry")), _num(c.get("targetPrice")), c["underlying"]
        if not vence or not objetivo:
            continue
        horas = (vence - ahora_ms) / 3_600_000
        ahora = _num(mids.get(sub))
        if not (horas_min <= horas <= horas_max) or not ahora:
            continue
        if sub not in vols:
            if len(vols) >= max_subyacentes:
                continue
            try:
                vols[sub] = _volatilidad(info, sub, ahora_ms)
            except Exception:  # sin velas: sin modelo
                vols[sub] = None
        v = vols[sub]
        p = prob_modelo(ahora, objetivo, v["sigma_h"], horas) if v else None
        if p is None:
            continue
        lados = []
        for i, sd in enumerate(o.get("sideSpecs") or []):
            cod = int(o["outcome"]) * 10 + i
            pr = _num(mids.get(f"#{cod}"))
            lados.append({"lado": i, "nombre": TRADUCE.get(sd.get("name"), sd.get("name")), "coin": f"#{cod}", "precio": pr,
                          "prob_modelo": round((p if i == 0 else 1 - p) * 100, 1),
                          "ventaja": round(((p if i == 0 else 1 - p) - pr) * 100, 1) if pr is not None else None})
        out.append({"mercado": int(o["outcome"]), "pregunta": _pregunta(o, {}), "subyacente": sub, "objetivo": objetivo,
                    "precio_actual": ahora, "distancia_pct": round((ahora / objetivo - 1) * 100, 2), "vence": vence,
                    "horas": round(horas, 1), "cambio_24h_pct": v.get("cambio_24h_pct"), "lados": lados})
    return out


def proponer(cfg, lista, posiciones, pendientes, libre, opinar):
    """La IA revisa los mejores candidatos y tus posiciones. Devuelve
    (órdenes_nuevas, notas, resumen). Las órdenes salen con `limite` = precio medio:
    quien llama lo cambia por el mejor precio real del libro antes de crearlas.
    `opinar(candidatos, posiciones)` → ({coin: {accion, confianza, prob, razon}}, modelo, error)."""
    ventaja_min = float(cfg.get("pred_ventaja") or 8)
    monto, tope = float(cfg.get("pred_monto") or 11), float(cfg.get("pred_max_total") or 30)
    conf_min = float(cfg.get("ia_conf_min") or 65)
    abiertos = {int(str(p["coin"]).lstrip("+")) // 10 for p in posiciones}
    pend = {(str(o.get("coin")), o.get("accion")) for o in pendientes if o.get("tipo") == "prediccion"}
    abiertos |= {int(c.lstrip("#")) // 10 for c, _ in pend if c.lstrip("#").isdigit()}
    por_mercado = {m["mercado"]: m for m in lista}

    cands = []
    for m in lista:
        if m["mercado"] in abiertos:
            continue
        for ld in m["lados"]:
            if ld["precio"] is not None and 0.05 <= ld["precio"] <= 0.95 and (ld["ventaja"] or 0) >= ventaja_min:
                cands.append({"coin": ld["coin"], "pregunta": m["pregunta"], "lado": ld["nombre"], "precio": ld["precio"],
                              "prob_mercado_pct": round(ld["precio"] * 100, 1), "prob_modelo_pct": ld["prob_modelo"], "ventaja_pts": ld["ventaja"],
                              "subyacente": m["subyacente"], "precio_actual": m["precio_actual"], "objetivo": m["objetivo"],
                              "distancia_pct": m["distancia_pct"], "horas_para_vencer": m["horas"], "cambio_24h_pct": m["cambio_24h_pct"]})
    cands.sort(key=lambda x: -x["ventaja_pts"])
    cands = cands[:3]

    revisar = []
    for p in posiciones:
        if p.get("precio") is None or (p.get("vence") and p["vence"] < time.time() * 1000):
            continue
        cod = int(str(p["coin"]).lstrip("+"))
        m = por_mercado.get(cod // 10)
        ld = (m or {}).get("lados", [None, None])[cod % 10] if m and cod % 10 < len(m["lados"]) else None
        revisar.append({"coin": f"#{cod}", "pregunta": p["pregunta"], "lado": p["lado_nombre"], "unidades": p["cantidad"], "precio": p["precio"],
                        "prob_mercado_pct": round(p["precio"] * 100, 1), "prob_modelo_pct": ld and ld["prob_modelo"],
                        "ventaja_pts": ld and ld["ventaja"], "horas_para_vencer": m and m["horas"],
                        "precio_actual": m and m["precio_actual"], "objetivo": m and m["objetivo"]})

    resumen = {"ts": int(time.time() * 1000), "revisados": len(lista), "candidatos": len(cands), "posiciones": len(revisar),
               "modelo": None, "opiniones": [], "modo": cfg.get("pred_ia", "proponer")}
    if not cands and not revisar:
        return [], [], resumen
    opin, modelo, error = opinar(cands, revisar)
    resumen["modelo"] = modelo
    if error:
        return [], [f"IA predicciones: {error}"], resumen
    notas, nuevas = [], []
    for x in cands + revisar:
        o = opin.get(x["coin"])
        if o:
            resumen["opiniones"].append({"coin": x["coin"], "pregunta": x["pregunta"], "lado": x["lado"], **o})

    # Compra: como mucho una por ciclo, con monto fijo y sin pasar tu tope total.
    expuesto = sum(p.get("valor") or 0 for p in posiciones) + sum(
        float(o.get("unidades") or 0) * float(o.get("limite") or 0) for o in pendientes if o.get("tipo") == "prediccion" and o.get("accion") == "COMPRAR")
    for c in cands:
        o = opin.get(c["coin"]) or {}
        if o.get("accion") != "COMPRAR" or o.get("confianza", 0) < conf_min:
            continue
        if o.get("prob") is not None and o["prob"] / 100 < c["precio"] + 0.03:
            continue  # la propia IA no ve margen suficiente
        if expuesto + monto > tope:
            notas.append(f"Predicciones: la IA quería comprar «{c['pregunta']} · {c['lado']}» pero pasaría tu tope de {tope:g} USDC")
            break
        if libre < monto:
            notas.append(f"Predicciones: la IA quería comprar «{c['pregunta']} · {c['lado']}» y solo tienes {libre:.2f} USDC libres")
            break
        nuevas.append({"tipo": "prediccion", "coin": c["coin"], "accion": "COMPRAR", "unidades": max(1, math.ceil(monto / c["precio"])),
                       "limite": c["precio"], "monto": monto, "etiqueta": f"{c['pregunta']} · {c['lado']}", "razon": o.get("razon", ""),
                       "confianza": o["confianza"], "origen": "ia", "precio_modelo": c["prob_modelo_pct"] / 100,
                       "ia": {"accion": "COMPRAR", "confianza": o["confianza"], "razon": o.get("razon", ""), "prob": o.get("prob")}})
        break

    # Venta: si la IA ve tu lado sobrevalorado (máx. una por ciclo).
    for r in revisar:
        o = opin.get(r["coin"]) or {}
        if o.get("accion") != "VENDER" or o.get("confianza", 0) < conf_min or (r["coin"], "VENDER") in pend or int(r["unidades"]) < 1:
            continue
        nuevas.append({"tipo": "prediccion", "coin": r["coin"], "accion": "VENDER", "unidades": int(r["unidades"]), "limite": r["precio"],
                       "etiqueta": f"{r['pregunta']} · {r['lado']}", "razon": o.get("razon", ""), "confianza": o["confianza"], "origen": "ia",
                       "ia": {"accion": "VENDER", "confianza": o["confianza"], "razon": o.get("razon", ""), "prob": o.get("prob")}})
        break
    return nuevas, notas, resumen
