import os
import unittest
from unittest import mock

import kumo_runner as K
import ordenes as O
from exchanges import CcxtExchange, ErrorExchange


class Ex:
    def __init__(self, lleno):
        self.lleno, self.llamadas = lleno, []

    def orden_prediccion(self, cod, comprar, unidades, limite):
        self.llamadas.append((cod, comprar, unidades, limite))
        if self.lleno is None:
            raise ErrorExchange("Hyperliquid: Insufficient balance")
        return {"cantidad": self.lleno, "precio": 0.51, "total": self.lleno * 0.51, "id": 7}


ORD = {"id": "p1", "tipo": "prediccion", "coin": "#90150", "simbolo": "#90150", "etiqueta": "¿BTC ≥ 85 501? · Sí", "accion": "COMPRAR", "unidades": 20, "limite": 0.52}


class OrdenPrediccion(unittest.TestCase):
    def test_compra_llena(self):
        ex = Ex(20)
        upd, op = O.ejecutar(ex, ORD, {}, {}, {}, {"quote": "USDC"}, False)
        self.assertEqual(ex.llamadas, [(90150, True, 20, 0.52)])
        self.assertEqual((upd["estado"], upd["resultado"]["cantidad"], op["simbolo"], op["prediccion"]), ("ejecutada", 20, "¿BTC ≥ 85 501? · Sí", "#90150"))

    def test_parcial_y_sin_llenar(self):
        upd, _ = O.ejecutar(Ex(5), ORD, {}, {}, {}, {"quote": "USDC"}, False)
        self.assertIn("5 de 20", upd["nota"])
        upd, op = O.ejecutar(Ex(0), ORD, {}, {}, {}, {"quote": "USDC"}, False)
        self.assertEqual((upd["estado"], op), ("error", None))
        self.assertIn("No se llenó", upd["error"])

    def test_error_y_simulacion(self):
        upd, _ = O.ejecutar(Ex(None), ORD, {}, {}, {}, {"quote": "USDC"}, False)
        self.assertIn("Insufficient", upd["error"])
        ex = Ex(20)
        upd, _ = O.ejecutar(ex, ORD, {}, {}, {}, {"quote": "USDC"}, True)
        self.assertEqual((upd["estado"], ex.llamadas), ("error", []))

    def test_accion_firmada(self):
        ex = CcxtExchange("hyperliquid", "USDC", "0x" + "0" * 39 + "1", "0x" + "11" * 32)
        vistos = {}
        ex.ex.private_post_exchange = lambda req: vistos.update(req) or {"status": "ok", "response": {"data": {"statuses": [{"filled": {"totalSz": "20", "avgPx": "0.5", "oid": 1}}]}}}
        r = ex.orden_prediccion(90151, False, 20, 0.4)
        o = vistos["action"]["orders"][0]
        self.assertEqual((o["a"], o["b"], o["p"], o["s"], o["t"]), (100090151, False, "0.4", "20", {"limit": {"tif": "Ioc"}}))
        self.assertEqual(list(o), ["a", "b", "p", "s", "r", "t"])  # orden de campos que exige Hyperliquid
        self.assertIn("r", vistos["signature"])
        self.assertEqual((r["cantidad"], r["total"]), (20, 10.0))
        with self.assertRaises(ErrorExchange):
            ex.orden_prediccion(90151, True, 1, 1.2)

    def test_ciclo_no_busca_precio_de_predicciones(self):
        from tests.test_ciclo_ordenes import Pub
        remoto = {"config": {"quote": "USDC", "objetivo": {}, "ia": "off"}, "estado_runner": {"cartera_sim": {"USDC": 100}}, "ordenes": [dict(ORD, estado="aprobada")]}
        with mock.patch.dict(os.environ, {"EXCHANGE_ID": "prueba", "EXCHANGE_API_KEY": ""}), mock.patch.object(K, "crear_publico", lambda *a: Pub()):
            r = K.ciclo(remoto)
        self.assertEqual(r["ordenes_upd"][0]["estado"], "error")
        self.assertIn("dinero real", r["ordenes_upd"][0]["error"])


if __name__ == "__main__":
    unittest.main()
