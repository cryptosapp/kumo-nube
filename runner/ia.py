"""Opinión de IA sobre las operaciones que propone la estrategia.

Sirve cualquier proveedor compatible con OpenAI (Kilo, Groq, Google AI Studio,
OpenRouter, Mistral…). Se configura con los secretos IA_URL, IA_MODELOS (lista
separada por comas) e IA_CLAVE (vacía en proveedores sin cuenta como Kilo).
Las nubes antiguas solo tienen GROQ_API_KEY: entonces se usa Groq como antes.
"""
import json
import os
import re
import urllib.error
import urllib.request

GROQ_URL = "https://api.groq.com/openai/v1"
GROQ_MODELOS = ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "llama-3.3-70b-versatile"]


def proveedor():
    """Devuelve (url_base, clave, [modelos], nombre) o None si no hay IA configurada."""
    url = os.getenv("IA_URL", "").strip().rstrip("/")
    if url:
        modelos = [m.strip() for m in os.getenv("IA_MODELOS", "").split(",") if m.strip()]
        nombre = re.sub(r"^https?://(api\.)?", "", url).split("/")[0]
        return url, os.getenv("IA_CLAVE", "").strip(), modelos, nombre
    clave = os.getenv("GROQ_API_KEY", "").strip()
    if clave:
        return GROQ_URL, clave, [m for m in [os.getenv("GROQ_MODEL")] + GROQ_MODELOS if m], "groq.com"
    return None


def extraer_json(texto):
    """Algunos modelos envuelven el JSON en ```json``` o en <think>…</think>."""
    texto = re.sub(r"<think>.*?</think>", "", texto or "", flags=re.S).strip()
    try:
        return json.loads(texto)
    except ValueError:
        a, b = texto.find("{"), texto.rfind("}")
        if a >= 0 and b > a:
            return json.loads(texto[a:b + 1])
        raise


def _llamar(url, clave, modelo, mensajes, formato_json=True):
    datos = {"model": modelo, "messages": mensajes, "temperature": 0.2}
    if formato_json:
        datos["response_format"] = {"type": "json_object"}
    cab = {"Content-Type": "application/json", "User-Agent": "kumo-bot/1.0"}
    if clave:
        cab["Authorization"] = f"Bearer {clave}"
    req = urllib.request.Request(url + "/chat/completions", data=json.dumps(datos).encode(), method="POST", headers=cab)
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.loads(r.read().decode())
    return resp["choices"][0]["message"]["content"]


def chat_json(mensajes):
    """Prueba cada modelo hasta que uno responda JSON. Devuelve (dict, modelo, error)."""
    prov = proveedor()
    if not prov:
        return None, None, "Sin IA configurada"
    url, clave, modelos, nombre = prov
    if not modelos:
        return None, None, f"Falta IA_MODELOS para {nombre}"
    ultimo_error = None
    for modelo in modelos:
        for formato_json in (True, False):
            try:
                return extraer_json(_llamar(url, clave, modelo, mensajes, formato_json)), modelo, None
            except urllib.error.HTTPError as e:
                ultimo_error = f"{nombre} HTTP {e.code} con {modelo}"
                if e.code in (401, 403):
                    return None, None, ultimo_error
                if e.code == 400 and formato_json:
                    continue  # el modelo no acepta response_format: reintenta sin él
                break
            except Exception as e:  # red, JSON inválido, etc.
                ultimo_error = f"{nombre}: {type(e).__name__} con {modelo}"
                break
    return None, None, ultimo_error


def opinar(propuestas, contexto):
    """Devuelve ({SIMBOLO: {accion, confianza, razon}}, modelo|None, error|None)."""
    if not propuestas:
        return {}, None, None
    filas = [{k: p.get(k) for k in ("simbolo", "accion", "precio", "rsi", "tendencia", "peso", "objetivo", "pnl", "motivo")} for p in propuestas]
    mensajes = [
        {"role": "system", "content": "Eres un analista de riesgo cripto prudente. Respondes SOLO JSON válido en español."},
        {"role": "user", "content": (
            "La estrategia automática propone estas operaciones spot. Para cada símbolo opina "
            "COMPRAR, VENDER o ESPERAR, con confianza 0-100 y una razón breve (máx. 20 palabras). "
            "Sé escéptico: si los datos no lo justifican, ESPERAR.\n"
            f"Contexto: {json.dumps(contexto, ensure_ascii=False)}\n"
            f"Propuestas: {json.dumps(filas, ensure_ascii=False)}\n"
            'Formato: {"opiniones":[{"simbolo":"BTC","accion":"ESPERAR","confianza":60,"razon":"..."}]}'
        )},
    ]
    datos, modelo, error = chat_json(mensajes)
    if datos is None:
        return {}, None, error
    out = {}
    for o in datos.get("opiniones", []) if isinstance(datos, dict) else []:
        try:
            sym = str(o.get("simbolo", "")).upper()
            if sym:
                out[sym] = {"accion": str(o.get("accion", "ESPERAR")).upper(), "confianza": max(0, min(100, int(float(o.get("confianza", 0) or 0)))), "razon": str(o.get("razon", ""))[:200]}
        except (AttributeError, TypeError, ValueError):
            continue
    return out, modelo, None
