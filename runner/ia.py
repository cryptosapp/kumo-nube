"""Opinión de IA (Groq) sobre las operaciones que propone la estrategia."""
import json
import os
import urllib.request

URL = "https://api.groq.com/openai/v1/chat/completions"
MODELOS = ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "llama-3.3-70b-versatile"]


def _llamar(clave, modelo, mensajes):
    cuerpo = json.dumps({"model": modelo, "messages": mensajes, "temperature": 0.2, "response_format": {"type": "json_object"}}).encode()
    req = urllib.request.Request(URL, data=cuerpo, method="POST", headers={"Authorization": f"Bearer {clave}", "Content-Type": "application/json", "User-Agent": "kumo-bot/1.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        datos = json.loads(r.read().decode())
    return datos["choices"][0]["message"]["content"]


def opinar(propuestas, contexto):
    """Devuelve ({SIMBOLO: {accion, confianza, razon}}, modelo|None, error|None)."""
    clave = os.getenv("GROQ_API_KEY", "")
    if not propuestas:
        return {}, None, None
    if not clave:
        return {}, None, "Sin GROQ_API_KEY"
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
    modelos = [m for m in [os.getenv("GROQ_MODEL")] + MODELOS if m]
    ultimo_error = None
    for modelo in modelos:
        try:
            texto = _llamar(clave, modelo, mensajes)
            datos = json.loads(texto)
            out = {}
            for o in datos.get("opiniones", []):
                sym = str(o.get("simbolo", "")).upper()
                if sym:
                    out[sym] = {"accion": str(o.get("accion", "ESPERAR")).upper(), "confianza": max(0, min(100, int(float(o.get("confianza", 0) or 0)))), "razon": str(o.get("razon", ""))[:200]}
            return out, modelo, None
        except urllib.error.HTTPError as e:
            ultimo_error = f"Groq HTTP {e.code} con {modelo}"
            if e.code in (401, 403):
                break
        except Exception as e:  # red, JSON inválido, etc.
            ultimo_error = f"Groq: {type(e).__name__} con {modelo}"
    return {}, None, ultimo_error
