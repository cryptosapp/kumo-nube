import time
import unittest

import kumo_runner as K
import predicciones as PR

AHORA = int(time.time() * 1000)
VENCE = time.strftime("%Y%m%d-%H%M", time.gmtime(AHORA / 1000 + 6 * 3600))


def info_falsa(sol=125.0, si=0.40, sigma_cambio=0.004):
    """Hyperliquid de mentira: un mercado «¿SOL ≥ 120?» que vence en 6 h."""
    def info(c):
        t = c["type"]
        if t == "outcomeMeta":
            return {"outcomes": [{"outcome": 9017, "name": "x", "description": f"class:priceBinary|underlying:SOL|expiry:{VENCE}|targetPrice:120",
                                  "sideSpecs": [{"name": "Yes"}, {"name": "No"}]}], "questions": []}
        if t == "allMids":
            return {"SOL": str(sol), "#90170": str(si), "#90171": str(round(1 - si, 3))}
        if t == "candleSnapshot":
            return [{"c": str(sol * (1 + sigma_cambio * (-1) ** i))} for i in range(48)]
        raise AssertionError(t)
    return info


def opinar_fijo(resp):
    llamadas = []

    def f(cands, pos):
        llamadas.append((cands, pos))
        return resp, "modelo-x", None
    f.llamadas = llamadas
    return f


CFG = {"pred_ia": "proponer", "pred_monto": 11, "pred_max_total": 30, "pred_ventaja": 8, "ia_conf_min": 65}


class Mercados(unittest.TestCase):
    def test_modelo_y_ventaja(self):
        l = PR.mercados(info_falsa(), AHORA)
        self.assertEqual(len(l), 1)
        m = l[0]
        self.assertEqual((m["mercado"], m["subyacente"], m["objetivo"]), (9017, "SOL", 120.0))
        si, no = m["lados"]
        self.assertGreater(si["prob_modelo"], 90)  # SOL 4 % arriba con poca volatilidad
        self.assertGreater(si["ventaja"], 40)
        self.assertLess(no["ventaja"], 0)
        self.assertEqual((si["coin"], si["nombre"]), ("#90170", "Sí"))

    def test_fuera_de_ventana(self):
        self.assertEqual(PR.mercados(info_falsa(), AHORA, horas_max=2), [])


class Proponer(unittest.TestCase):
    def test_compra_con_ia_de_acuerdo(self):
        op = opinar_fijo({"#90170": {"accion": "COMPRAR", "confianza": 80, "prob": 85, "razon": "SOL lejos del objetivo"}})
        nuevas, notas, res = PR.proponer(CFG, PR.mercados(info_falsa(), AHORA), [], [], 50, op)
        self.assertEqual(len(nuevas), 1)
        o = nuevas[0]
        self.assertEqual((o["tipo"], o["coin"], o["accion"], o["unidades"], o["origen"]), ("prediccion", "#90170", "COMPRAR", 28, "ia"))
        self.assertEqual((res["candidatos"], res["modelo"], len(res["opiniones"])), (1, "modelo-x", 1))

    def test_ia_dice_no_o_poca_confianza(self):
        for r in ({"#90170": {"accion": "NO ENTRAR", "confianza": 90, "prob": 40, "razon": ""}},
                  {"#90170": {"accion": "COMPRAR", "confianza": 50, "prob": 85, "razon": ""}},
                  {"#90170": {"accion": "COMPRAR", "confianza": 90, "prob": 41, "razon": ""}}):
            nuevas, _, _ = PR.proponer(CFG, PR.mercados(info_falsa(), AHORA), [], [], 50, opinar_fijo(r))
            self.assertEqual(nuevas, [], r)

    def test_tope_y_saldo(self):
        op = opinar_fijo({"#90170": {"accion": "COMPRAR", "confianza": 80, "prob": 85, "razon": ""}})
        pos = [{"coin": "+90151", "valor": 25, "precio": 0.5, "cantidad": 50, "pregunta": "¿BTC?", "lado_nombre": "Sí"}]
        nuevas, notas, _ = PR.proponer(CFG, PR.mercados(info_falsa(), AHORA), pos, [], 50, op)
        self.assertEqual(nuevas, [])
        self.assertIn("tope", notas[0])
        nuevas, notas, _ = PR.proponer(CFG, PR.mercados(info_falsa(), AHORA), [], [], 3, op)
        self.assertEqual(nuevas, [])
        self.assertIn("libres", notas[0])

    def test_no_repite_mercado_con_posicion_o_pendiente(self):
        op = opinar_fijo({"#90170": {"accion": "COMPRAR", "confianza": 80, "prob": 85, "razon": ""}})
        pend = [{"tipo": "prediccion", "coin": "#90171", "accion": "COMPRAR", "unidades": 10, "limite": 0.5}]
        nuevas, _, res = PR.proponer(CFG, PR.mercados(info_falsa(), AHORA), [], pend, 50, op)
        self.assertEqual((nuevas, res["candidatos"]), ([], 0))
        self.assertEqual(op.llamadas, [])  # sin nada que revisar no se gasta IA

    def test_vende_posicion(self):
        pos = [{"coin": "+90171", "valor": 6, "precio": 0.6, "cantidad": 10.0, "pregunta": "¿SOL ≥ 120?", "lado_nombre": "No", "vence": AHORA + 3600_000}]
        op = opinar_fijo({"#90171": {"accion": "VENDER", "confianza": 75, "prob": 10, "razon": "SOL muy arriba"}})
        nuevas, _, res = PR.proponer(CFG, PR.mercados(info_falsa(si=0.4), AHORA), pos, [], 50, op)
        self.assertEqual([(o["coin"], o["accion"], o["unidades"]) for o in nuevas], [("#90171", "VENDER", 10)])
        self.assertEqual(res["posiciones"], 1)
        self.assertLess(op.llamadas[0][1][0]["ventaja_pts"], 0)


class Base:
    """Exchange de mentira para predicciones_ia: libro y órdenes."""
    def __init__(self, ask=0.42, bid=0.38, lleno=True):
        self.ask, self.bid, self.lleno, self.ordenes = ask, bid, lleno, []
        self._info_hl = info_falsa()

    def mejor_precio_prediccion(self, cod, comprar):
        p = self.ask if comprar else self.bid
        return {"precio": p, "unidades": 100} if p else None


class EnElCiclo(unittest.TestCase):
    def setUp(self):
        self.orig = K.ia.opinar_predicciones
        K.ia.opinar_predicciones = lambda c, p: ({"#90170": {"accion": "COMPRAR", "confianza": 80, "prob": 85, "razon": "ok"}}, "m", None)

    def tearDown(self):
        K.ia.opinar_predicciones = self.orig

    def test_usa_el_libro(self):
        notas = []
        nuevas, res = K.predicciones_ia(Base(ask=0.44), None, CFG, [], [], 50, notas)
        self.assertEqual(len(nuevas), 1)
        o = nuevas[0]
        self.assertEqual((o["limite"], o["unidades"], o["estado"]), (0.44, 25, "propuesta"))
        self.assertNotIn("monto", o)
        self.assertNotIn("precio_modelo", o)
        self.assertGreater(o["caduca"], AHORA)

    def test_sin_vendedores_o_spread_grande(self):
        notas = []
        self.assertEqual(K.predicciones_ia(Base(ask=None), None, CFG, [], [], 50, notas)[0], [])
        self.assertIn("no hay vendedores", notas[-1])
        self.assertEqual(K.predicciones_ia(Base(ask=0.60), None, CFG, [], [], 50, notas)[0], [])
        self.assertIn("ya no tiene ventaja", notas[-1])


if __name__ == "__main__":
    unittest.main()


class HLFalso(Base):
    """Cuenta real de Hyperliquid de mentira para un ciclo completo."""
    id, quote, con_claves = "hyperliquid", "USDC", True

    def __init__(self):
        super().__init__(ask=0.44)
        self.usdc, self.predicciones = 50.0, {}

    def saldos(self):
        return {"USDC": self.usdc}

    def precios(self, s):
        return {}

    def velas(self, s, marco="1h", n=100):
        return []

    def mercados_top(self, n=20):
        return []

    def orden_prediccion(self, cod, comprar, unidades, limite):
        self.ordenes.append((cod, comprar, unidades, limite))
        self.usdc -= unidades * limite
        self.predicciones = {f"+{cod}": float(unidades)}
        return {"cantidad": unidades, "precio": limite, "total": unidades * limite, "id": 1}


class CicloAuto(unittest.TestCase):
    def correr(self, modo):
        import os
        from unittest import mock
        hl = HLFalso()
        remoto = {"config": {"modo": "real", "quote": "USDC", "objetivo": {}, "ia": "veto", "pred_ia": modo, "ordenes_ia": "off"}, "ordenes": []}
        with mock.patch.dict(os.environ, {"EXCHANGE_ID": "hyperliquid", "EXCHANGE_API_KEY": "0xabc", "EXCHANGE_SECRET": "x"}), \
                mock.patch.object(K, "crear_exchange", lambda *a: hl), \
                mock.patch.object(K.ia, "opinar", lambda *a: ({}, None, None)), \
                mock.patch.object(K.ia, "opinar_predicciones", lambda c, p: ({"#90170": {"accion": "COMPRAR", "confianza": 80, "prob": 85, "razon": "ok"}}, "m", None)):
            return K.ciclo(remoto), hl

    def test_proponer_no_toca_dinero(self):
        r, hl = self.correr("proponer")
        self.assertEqual(hl.ordenes, [])
        self.assertEqual([(o["coin"], o["estado"]) for o in r["ordenes_nuevas"]], [("#90170", "propuesta")])
        self.assertEqual(r["pred_ia"]["candidatos"], 1)

    def test_auto_ejecuta_al_mejor_precio(self):
        r, hl = self.correr("auto")
        self.assertEqual(hl.ordenes, [(90170, True, 25, 0.44)])
        o = r["ordenes_nuevas"][0]
        self.assertEqual(o["estado"], "ejecutada")
        self.assertEqual(r["ejecutadas"][0]["prediccion"], "#90170")
        self.assertEqual(r["libre"], 39.0)

    def test_off(self):
        r, hl = self.correr("off")
        self.assertEqual((r["ordenes_nuevas"], r["pred_ia"]), ([], None))
