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

        def chat(m):
            vistos.append(m[1]["content"])
            return {"cambios": {"pred_ventaja": 10}, "razon": "Muchas órdenes sin llenar"}, "m1", None
        r = SUP.revisar(CFG, [{"accion": "COMPRAR", "estado": "error", "error": "No se llenó"}], [], {"revisados": 4}, chat)
        self.assertEqual((r["cambios"], r["modelo"]), ({"pred_ventaja": 10.0}, "m1"))
        self.assertIn("No se llenó", vistos[0])
        self.assertIsNone(SUP.revisar(CFG, [], [], None, lambda m: (None, None, "caída")))

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
