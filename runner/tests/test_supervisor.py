import os
import unittest
from unittest import mock

import kumo_runner as K
import supervisor as SUP
from tests.test_pred_ia import HLFalso, OPS, lista

CFG = {"pred_ia": "proponer", "ia": "veto", "pred_ventaja": 8, "pred_conf_min": 65, "pred_monto": 11, "pred_max_total": 30,
       "pred_monto_techo": 20, "pred_max_total_techo": 30, "pred_prob_min": 5, "pred_prob_max": 95, "pred_categorias": ["cripto_hoy"]}


class Supervisor(unittest.TestCase):
    def test_cuando_toca(self):
        self.assertTrue(SUP.toca(CFG, None))
        self.assertFalse(SUP.toca(CFG, 10_000, ahora=10_000 + 3600_000))
        self.assertTrue(SUP.toca(CFG, 10_000, ahora=10_000 + 7 * 3600_000))
        for k, v in (("pred_supervisor", False), ("pred_ia", "off"), ("ia", "off")):
            self.assertFalse(SUP.toca({**CFG, k: v}, None))

    def test_limpia_y_respeta_techos(self):
        c = SUP.limpiar(CFG, {"pred_ventaja": 12, "pred_monto": 50, "pred_max_total": 100, "modo": "real", "pred_ia": "auto",
                              "pred_conf_min": 10, "pred_categorias": ["bolsa", "deportes"], "pred_prob_max": 95})
        self.assertEqual(c, {"pred_ventaja": 12.0, "pred_monto": 20.0, "pred_conf_min": 50, "pred_categorias": ["bolsa"]})

    def test_revisar(self):
        vistos = []

        def varias(m, valido):
            vistos.append(m[1]["content"])
            return [("m1", {"cambios": {"pred_ventaja": 10}, "razon": "Muchas órdenes sin llenar"})], None
        r = SUP.revisar(CFG, [{"accion": "COMPRAR", "estado": "error", "error": "No se llenó"}], [], {"revisados": 4}, varias)
        self.assertEqual((r["cambios"], r["modelo"]), ({"pred_ventaja": 10.0}, "m1"))
        self.assertIn("No se llenó", vistos[0])
        self.assertIsNone(SUP.revisar(CFG, [], [], None, lambda m, v: ([], "caída")))

    def test_consenso_del_supervisor(self):
        """Un cambio pasa solo si más de la mitad lo pide, al valor mediano; las categorías,
        solo las que todas dejan; y nunca pasa los techos del usuario."""
        resp = [("a/x:free", {"cambios": {"pred_ventaja": 10, "pred_monto": 15, "pred_categorias": ["cripto_hoy"]}, "razon": "ra"}),
                ("b", {"cambios": {"pred_ventaja": 14, "pred_max_ciclo": 1}, "razon": "rb"}),
                ("c", {"cambios": {"pred_ventaja": 12, "pred_monto": 50}, "razon": "rc"})]
        r = SUP.revisar(CFG, [], [], None, lambda m, v: ([x for x in resp if v(x[1])], None))
        # ventaja 3/3 → mediana 12; monto 2/3 → mediana de 15 y 20 (50 recortado al techo) = 17.5;
        # pred_max_ciclo solo 1/3 → no cambia.
        self.assertEqual(r["cambios"], {"pred_ventaja": 12.0, "pred_monto": 17.5})
        self.assertEqual(r["modelo"], "consenso:x+b+c")
        self.assertIn("Consenso de 3 IAs", r["razon"])
        # 1 de 2 no es mayoría: nada cambia.
        r2 = SUP.revisar(CFG, [], [], None, lambda m, v: ([resp[0], ("b", {"cambios": {}, "razon": "todo bien"})], None))
        self.assertEqual(r2["cambios"], {})
        # Una respuesta con «cambios» que no es un objeto no cuenta como voto.
        validos = []
        SUP.revisar(CFG, [], [], None, lambda m, v: (validos.extend([v({"cambios": [1]}), v({"cambios": {}})]), ([], "x"))[1])
        self.assertEqual(validos, [False, True])

    def test_en_el_ciclo_cada_6h(self):
        def correr(super_ts):
            hl = HLFalso()
            remoto = {"config": {"modo": "real", "quote": "USDC", "objetivo": {}, "ia": "veto", "pred_ia": "proponer", "ordenes_ia": "off"},
                      "ordenes": [], "estado_runner": {"super_ts": super_ts}}
            with mock.patch.dict(os.environ, {"EXCHANGE_ID": "hyperliquid", "EXCHANGE_API_KEY": "0xabc", "EXCHANGE_SECRET": "x"}), \
                    mock.patch.object(K, "crear_exchange", lambda *a: hl), \
                    mock.patch.object(K, "http", lambda *a, **k: {"mercados": lista()}), \
                    mock.patch.object(K, "url_nube", lambda: "https://nube"), \
                    mock.patch.object(K.ia, "opinar", lambda *a: ({}, None, None)), \
                    mock.patch.object(K.ia, "opinar_predicciones", lambda c, p, *_: (OPS, "m", None)), \
                    mock.patch.object(K.ia, "chat_json", lambda m: ({"cambios": {"pred_ventaja": 11}, "razon": "r"}, "m", None)):
                return K.ciclo(remoto)
        self.assertEqual(correr(None)["supervisor"]["cambios"], {"pred_ventaja": 11.0})
        import time
        self.assertIsNone(correr(int(time.time() * 1000))["supervisor"])


class ComprarMas(unittest.TestCase):
    def test_compra_mas_con_senal_fuerte(self):
        import predicciones as PR
        pos = [{"coin": "+90170", "valor": 4, "precio": 0.40, "cantidad": 10.0, "pregunta": "¿SOL ≥ 120?", "lado_nombre": "Sí"}]
        op = lambda c, p: ({"#90170": {"accion": "COMPRAR MÁS", "confianza": 85, "prob": 80, "razon": "sigue barato"}}, "m", None)
        nuevas, _, _ = PR.proponer({**CFG}, lista(), pos, [], 50, op, lambda cod, comprar: {"precio": 0.42, "unidades": 50})
        self.assertEqual([(o["coin"], o["accion"], o["unidades"], o["limite"]) for o in nuevas], [("#90170", "COMPRAR", 27, 0.42)])
        self.assertIn("Comprar más", nuevas[0]["razon"])
        débil = lambda c, p: ({"#90170": {"accion": "COMPRAR MÁS", "confianza": 50, "prob": 80, "razon": ""}}, "m", None)
        self.assertEqual(PR.proponer({**CFG}, lista(), pos, [], 50, débil)[0], [])


if __name__ == "__main__":
    unittest.main()
