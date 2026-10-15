"""Protección por giro: vender (y pasar al otro lado) cuando el mercado se da vuelta."""
import time
import unittest

import kumo_runner as K
import predicciones as PR
from test_pred_ia import AHORA, Base, HLFalso, lista, mercado

H = 3_600_000


def pos(precio=0.30, costo=0.86, cantidad=20, coin="+90171", vence=None):
    """Tu «No» del mercado 9017 (lado 1)."""
    return {"coin": coin, "pregunta": "¿SOL ≥ 120 al vencer?", "lado_nombre": "No", "cantidad": cantidad, "precio": precio,
            "valor": round(cantidad * precio, 2), "costo": costo, "vence": vence or AHORA + 6 * H}


CFG = {"pred_giro": "girar", "pred_giro_umbral": 40, "pred_max_total": 30, "pred_prob_max": 95}


class Detectar(unittest.TestCase):
    def test_apagada_no_hace_nada(self):
        self.assertEqual(PR.giros({**CFG, "pred_giro": "off"}, lista(si=0.70, prob=80), [pos()], set(), []), ([], []))
        self.assertEqual(PR.giros({}, lista(si=0.70, prob=80), [pos()], set(), []), ([], []))

    def test_el_caso_del_no_a_086(self):
        planes, notas = PR.giros(CFG, lista(si=0.70, prob=80), [pos()], set(), [])
        self.assertEqual(len(planes), 1, notas)
        g = planes[0]
        self.assertEqual((g["coin"], g["unidades"], g["mercado"], g["otro"]["coin"]), ("#90171", 20, 9017, "#90170"))
        self.assertIn("cayó de 0.86 a 0.3", g["razon"])

    def test_solo_vender_no_compra_el_otro_lado(self):
        planes, _ = PR.giros({**CFG, "pred_giro": "vender"}, lista(si=0.70, prob=80), [pos()], set(), [])
        self.assertNotIn("otro", planes[0])

    def test_sobre_el_umbral_no_actua(self):
        self.assertEqual(PR.giros(CFG, lista(si=0.55, prob=60), [pos(precio=0.45)], set(), [])[0], [])

    def test_si_la_compraste_barata_no_es_un_giro(self):
        self.assertEqual(PR.giros(CFG, lista(si=0.70, prob=80), [pos(costo=0.35)], set(), [])[0], [])

    def test_el_modelo_tiene_que_confirmarlo(self):
        planes, notas = PR.giros(CFG, lista(si=0.70, prob=40), [pos()], set(), [])
        self.assertEqual(planes, [])
        self.assertTrue(any("vaivén" in n and "60%" in n for n in notas), notas)

    def test_sin_modelo_no_vende(self):
        planes, notas = PR.giros(CFG, [], [pos()], set(), [])
        self.assertEqual(planes, [])
        self.assertTrue(any("no hay modelo" in n for n in notas), notas)

    def test_sin_costo_no_toca(self):
        planes, notas = PR.giros(CFG, lista(si=0.70, prob=80), [pos(costo=None)], set(), [])
        self.assertEqual(planes, [])
        self.assertTrue(any("no sé a cuánto" in n for n in notas), notas)

    def test_una_sola_vez_por_mercado(self):
        self.assertEqual(PR.giros(CFG, lista(si=0.70, prob=80), [pos()], {9017}, [])[0], [])

    def test_vencida_o_con_venta_pendiente_no(self):
        self.assertEqual(PR.giros(CFG, lista(si=0.70, prob=80), [pos(vence=AHORA - H)], set(), [])[0], [])
        pend = [{"tipo": "prediccion", "coin": "#90171", "accion": "VENDER"}]
        self.assertEqual(PR.giros(CFG, lista(si=0.70, prob=80), [pos()], set(), pend)[0], [])


class Ex(Base):
    def __init__(self, ask=0.44, bid=0.28, usdc=10.0):
        super().__init__(ask=ask, bid=bid)
        self.usdc, self.entradas = usdc, {"+90171": 0.86}

    def saldos(self):
        return {"USDC": self.usdc}

    def orden_prediccion(self, cod, comprar, unidades, limite):
        self.ordenes.append((cod, comprar, unidades, limite))
        self.usdc += -unidades * limite if comprar else unidades * limite
        return {"cantidad": unidades, "precio": limite, "total": unidades * limite, "id": 1}


def plan(**kw):
    return PR.giros({**CFG, **kw}, lista(si=0.70, prob=80), [pos()], set(), [])[0]


class Ejecutar(unittest.TestCase):
    def test_vende_con_perdida_y_compra_el_otro_lado_con_lo_cobrado(self):
        ex, notas = Ex(), []
        ordenes, ops = K.ejecutar_giros(ex, ex, CFG, plan(), [pos()], notas)
        # Vende 20 «No» a 0.28 (5.6 USDC) y con eso compra 12 «Sí» a 0.44 (5.28): no pone dinero nuevo.
        self.assertEqual(ex.ordenes, [(90171, False, 20, 0.28), (90170, True, 12, 0.44)])
        self.assertEqual([(o["accion"], o["estado"], o["giro"]) for o in ordenes], [("VENDER", "ejecutada", 9017), ("COMPRAR", "ejecutada", 9017)])
        self.assertTrue(ordenes[0]["permitir_perdida"])
        self.assertEqual(ops[0]["pnl"], -67.44)
        self.assertTrue(any(n.startswith("🔄 Giro: vendí 20") for n in notas), notas)

    def test_sin_ventaja_del_otro_lado_solo_vende(self):
        ex, notas = Ex(ask=0.80), []
        ordenes, _ = K.ejecutar_giros(ex, ex, CFG, plan(), [pos()], notas)
        self.assertEqual([o["accion"] for o in ordenes], ["VENDER"])
        self.assertTrue(any("sin ventaja suficiente. Solo vendí" in n for n in notas), notas)

    def test_solo_vender(self):
        ex = Ex()
        ordenes, _ = K.ejecutar_giros(ex, ex, CFG, plan(pred_giro="vender"), [pos()], [])
        self.assertEqual(ex.ordenes, [(90171, False, 20, 0.28)])

    def test_si_ya_no_vale_nada_no_vende(self):
        ex, notas = Ex(bid=0.005), []
        self.assertEqual(K.ejecutar_giros(ex, ex, CFG, plan(), [pos()], notas), ([], []))
        self.assertTrue(any("casi no vale nada" in n for n in notas), notas)

    def test_sin_compradores(self):
        ex, notas = Ex(bid=None), []
        self.assertEqual(K.ejecutar_giros(ex, ex, CFG, plan(), [pos()], notas), ([], []))

    def test_respeta_el_tope(self):
        ex, notas = Ex(), []
        otras = [pos(), {**pos(coin="+80000"), "valor": 29.5}]
        ordenes, _ = K.ejecutar_giros(ex, ex, CFG, plan(), otras, notas)
        self.assertEqual([o["accion"] for o in ordenes], ["VENDER"])
        self.assertTrue(any("pasaría tu tope" in n for n in notas), notas)


class HLGiro(HLFalso):
    """Cuenta con «No» comprado a 0.86 que ahora vale 0.30."""
    def __init__(self):
        super().__init__()
        self.bid, self.usdc = 0.28, 10.0
        self.predicciones, self.entradas = {"+90171": 20}, {"+90171": 0.86}

    def _info_hl(self, c):
        if c.get("type") == "outcomeMeta":
            return {"outcomes": [{"outcome": 9017, "sideSpecs": [{"name": "Yes"}, {"name": "No"}], "description": ""}]}
        if c.get("type") == "allMids":
            return {"#90171": "0.30", "#90170": "0.70"}
        return {}

    def orden_prediccion(self, cod, comprar, unidades, limite):
        r = super().orden_prediccion(cod, comprar, unidades, limite)
        if not comprar:
            self.usdc += 2 * unidades * limite
        k = f"+{cod}"
        self.predicciones[k] = self.predicciones.get(k, 0) + (unidades if comprar else -unidades)
        if not self.predicciones[k]:
            del self.predicciones[k]
        return r


class EnElCiclo(unittest.TestCase):
    def correr(self, giro="girar", previos=None, pausado=False):
        import os
        from unittest import mock
        hl = HLGiro()
        remoto = {"config": {"modo": "real", "quote": "USDC", "objetivo": {}, "ia": "off", "pred_ia": "off", "ordenes_ia": "off",
                             "pred_giro": giro, "pred_giro_umbral": 40, "pausado": pausado},
                  "ordenes": [], "estado_runner": {"giros": previos or {}}}
        with mock.patch.dict(os.environ, {"EXCHANGE_ID": "hyperliquid", "EXCHANGE_API_KEY": "0xabc", "EXCHANGE_SECRET": "x", "KUMO_RUNNER_TOKEN": "t"}), \
                mock.patch.object(K, "crear_exchange", lambda *a: hl), \
                mock.patch.object(K, "http", lambda *a, **k: {"mercados": [mercado(si=0.70, prob=80)]}), \
                mock.patch.object(K, "url_nube", lambda: "https://nube"), \
                mock.patch.object(K.ia, "opinar", lambda *a: ({}, None, None)):
            return K.ciclo(remoto), hl

    def test_funciona_aunque_la_ia_este_apagada(self):
        r, hl = self.correr()
        self.assertEqual(hl.ordenes, [(90171, False, 20, 0.28), (90170, True, 12, 0.44)])
        self.assertEqual([(o["accion"], o["estado"]) for o in r["ordenes_nuevas"]], [("VENDER", "ejecutada"), ("COMPRAR", "ejecutada")])
        self.assertEqual(len([e for e in r["ejecutadas"] if e.get("prediccion")]), 2)
        self.assertIn("9017", r["giros"])
        self.assertEqual([p["coin"] for p in r["predicciones"]], ["+90170"])

    def test_no_se_repite_en_el_mismo_mercado(self):
        r, hl = self.correr(previos={"9017": int(time.time() * 1000) - H})
        self.assertEqual(hl.ordenes, [])

    def test_un_giro_viejo_se_olvida_a_las_dos_semanas(self):
        r, hl = self.correr(previos={"9017": int(time.time() * 1000) - 15 * 24 * H})
        self.assertEqual(len(hl.ordenes), 2)

    def test_apagada_o_en_pausa_no_toca_nada(self):
        for kw in ({"giro": "off"}, {"pausado": True}):
            r, hl = self.correr(**kw)
            self.assertEqual(hl.ordenes, [], kw)
            self.assertEqual(r["giros"], {})


if __name__ == "__main__":
    unittest.main()
