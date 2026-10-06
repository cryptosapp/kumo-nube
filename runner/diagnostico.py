#!/usr/bin/env python3
"""Diagnóstico de tu nube Kumo (Actions → «Diagnóstico Kumo» → Run workflow).

Revisa el exchange, la IA y la nube con TUS secretos y explica qué falla.
Nunca imprime claves ni montos: solo sí/no, contadores y mensajes de error.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ia  # noqa: E402
from exchanges import ErrorExchange, crear_exchange  # noqa: E402
from kumo_runner import url_nube  # noqa: E402

problemas = []


def linea(ok, texto):
    print(("✔ " if ok else "✖ ") + texto)
    if not ok:
        problemas.append(texto)


def exchange():
    print("\n== Exchange ==")
    ex_id, clave, secreto = os.getenv("EXCHANGE_ID", ""), os.getenv("EXCHANGE_API_KEY", ""), os.getenv("EXCHANGE_SECRET", "")
    print(f"Exchange: {ex_id or '(sin EXCHANGE_ID)'}")
    if not clave:
        linea(False, "Sin claves del exchange: el bot solo puede simular")
        return
    if ex_id == "hyperliquid":
        linea(clave.startswith("0x") and len(clave) == 42, "Dirección con formato 0x + 40 caracteres")
        s = secreto[2:] if secreto.startswith("0x") else secreto
        linea(len(s) == 64, "Clave privada de 64 caracteres hexadecimales")
        try:
            ex = crear_exchange(ex_id, "USDC", clave, secreto)
            corta = lambda d: f"{d[:6]}…{d[-4:]}"  # noqa: E731
            firmante = ex.ex.eth_get_address_from_private_key(ex.ex.privateKey)
            rol_p = ex._info_hl({"type": "userRole", "user": clave}).get("role")
            rol_f = ex._info_hl({"type": "userRole", "user": firmante})
            print(f"ℹ Dirección pegada {corta(clave)}: cuenta tipo «{rol_p}»")
            print(f"ℹ La clave privada es de {corta(firmante)}: cuenta tipo «{rol_f.get('role')}»" +
                  (f", API wallet de {corta(rol_f['data']['user'])}" if rol_f.get("role") == "agent" else ""))
            if rol_f.get("role") == "user":
                print("⚠ Esa clave privada es la de tu billetera principal: puede RETIRAR fondos. Crea una API wallet en Hyperliquid (More → API) y usa su clave.")
        except Exception as e:
            print(f"ℹ No pude comprobar las cuentas: {type(e).__name__}")
    try:
        ex = crear_exchange(ex_id, os.getenv("QUOTE", "USDC") if ex_id == "hyperliquid" else "USDT", clave, secreto, os.getenv("EXCHANGE_PASSWORD", ""))
        saldos = ex.saldos()
        if getattr(ex, "aviso_cuenta", None):
            print("ℹ " + ex.aviso_cuenta)
        linea(True, f"Saldo leído: {len(saldos)} monedas con saldo")
        estables = [k for k in saldos if k in ("USDC", "USDT", "USD")]
        linea(bool(estables), "Hay saldo en " + (", ".join(estables) if estables else "USDC/USDT (ninguno en Spot)"))
        if hasattr(ex, "saldo_perps") and ex_id == "hyperliquid":
            print(("ℹ Hay" if ex.saldo_perps() > 0 else "ℹ No hay") + " USDC en Perps")
    except ErrorExchange as e:
        linea(False, f"No pude leer el saldo: {e}")
    except Exception as e:
        linea(False, f"Error inesperado leyendo el saldo: {type(e).__name__}: {str(e)[:200]}")


def ia_directa():
    print("\n== IA (desde GitHub) ==")
    prov = ia.proveedor()
    if not prov:
        linea(False, "Sin IA configurada (faltan IA_URL / GROQ_API_KEY)")
        return
    url, clave, modelos, nombre = prov
    print(f"Proveedor: {nombre} · modelos: {', '.join(modelos) or '(ninguno)'} · clave: {'sí' if clave else 'no'}")
    t = time.time()
    datos, modelo, error = ia.chat_json([{"role": "user", "content": 'Responde solo este JSON: {"ok": true}'}])
    linea(datos is not None, f"La IA respondió con {modelo} en {time.time() - t:.1f} s" if datos is not None else f"La IA no respondió: {error}")


def nube():
    print("\n== Tu nube (lo que ve la app) ==")
    url, token = url_nube(), os.getenv("KUMO_APP_TOKEN", "")
    if not url or not token:
        linea(False, "Falta kumo.json o KUMO_APP_TOKEN")
        return

    def pedir(metodo, ruta, cuerpo=None):
        req = urllib.request.Request(url + ruta, method=metodo, data=json.dumps(cuerpo).encode() if cuerpo is not None else None,
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "kumo-bot/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode() or "{}")

    st, d = pedir("GET", "/api/estado")
    linea(st == 200, f"/api/estado responde ({st})")
    if st != 200:
        return
    u = d.get("ultimo") or {}
    print(f"Ciclo {d.get('ciclo')} · modo {(d.get('config') or {}).get('modo')} · IA en config: {(d.get('config') or {}).get('ia')}")
    real = u.get("real")
    linea(real is not None and not (real or {}).get("error"), "El último ciclo trae el saldo real" if real and not real.get("error") else f"El último ciclo NO trae el saldo real ({(real or {}).get('error') or 'campo ausente: ¿código viejo?'})")
    for e in u.get("errores") or []:
        print("⚠ error del ciclo: " + e)
    for n in u.get("notas") or []:
        print("· nota: " + n)
    st, sn = pedir("GET", "/api/senales")
    ult = (sn.get("senales") or [{}])[0] if st == 200 else {}
    linea(st == 200 and bool(ult.get("senales")), f"Señales de la IA: {len(sn.get('senales') or [])} registros; último: " +
          (", ".join(f"{x.get('simbolo')} {x.get('accion')} {x.get('confianza')}%" for x in ult.get("senales") or []) or "ninguna") if st == 200 else f"/api/senales falla ({st})")
    st, o = pedir("GET", "/api/ordenes")
    lista = o.get("ordenes") or []
    linea(st == 200, f"Órdenes: modo «{o.get('modo')}», {sum(1 for x in lista if x.get('estado') in ('propuesta', 'aprobada'))} pendientes, {len(lista)} en total" if st == 200 else f"/api/ordenes falla ({st})")
    for x in lista[:3]:
        print(f"· orden {x.get('origen')} {x.get('accion')} {x.get('simbolo')}: {x.get('estado')}" + (f" · {x.get('nota') or x.get('error')}" if x.get('nota') or x.get('error') else ""))
    st, h = pedir("GET", "/api/historial")
    items = h.get("items") or []
    linea(st == 200 and bool(items), f"Historial: {len(items)} registros" if st == 200 else f"/api/historial falla ({st})")
    for x in items[:8]:
        print(f"· {x.get('tipo')} {'✔' if x.get('ok') else '✖'} {x.get('texto')}")
    st, g = pedir("GET", "/api/graficas")
    sims = g.get("simbolos") or []
    linea(st == 200 and bool(sims), f"Gráficas: {', '.join(sims) or 'ninguna todavía'}" if st == 200 else f"/api/graficas falla ({st})")
    for s_ in sims[:3]:
        st, gs = pedir("GET", f"/api/graficas?simbolo={s_}")
        print(f"· {s_}: " + ", ".join(f"{m} {len(v.get('c') or [])} velas" for m, v in (gs.get("marcos") or {}).items()))
    st, sf = pedir("GET", "/api/semaforo")
    linea(st == 200, f"Semáforo: v{sf.get('version')} · ciclo #{sf.get('ciclo')} · IA {(sf.get('ia') or {}).get('proveedor')}" if st == 200 else f"/api/semaforo falla ({st})")
    st, pr = pedir("POST", "/api/ia/probar", {"todos": True})
    linea(st == 200 and pr.get("ok"), f"Prueba de IA: {pr.get('modelo')} en {pr.get('ms')} ms" + (f" · nuevo principal {pr.get('preferido_nuevo')}" if pr.get("preferido_nuevo") else "") if st == 200 else f"/api/ia/probar falla ({st})")
    for x in pr.get("pruebas") or []:
        print(f"· {'✔' if x.get('ok') else '✖'} {x.get('modelo')} {x.get('ms')} ms {x.get('error') or ''}")
    radar = d.get("radar") or []
    st, r = pedir("GET", "/api/radar")
    radar = r.get("radar") or []
    if not radar:
        linea(False, "El Radar aún no tiene monedas")
        return
    sym = radar[0].get("simbolo")
    t = time.time()
    st, a = pedir("POST", "/api/radar/analizar", {"simbolo": sym})
    linea(st == 200, f"Radar «Analizar con IA» de {sym}: {a.get('veredicto')} con {a.get('modelo')} en {time.time() - t:.1f} s" if st == 200 else f"Radar «Analizar con IA» de {sym} falla ({st}): {a.get('error')}")


if __name__ == "__main__":
    for paso in (exchange, ia_directa, nube):
        try:
            paso()
        except Exception as e:
            linea(False, f"{paso.__name__}: {type(e).__name__}: {str(e)[:200]}")
    print("\n" + ("TODO BIEN" if not problemas else f"{len(problemas)} PROBLEMA(S):\n- " + "\n- ".join(problemas)))
