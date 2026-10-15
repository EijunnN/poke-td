# -*- coding: utf-8 -*-
"""
Descargas con reintentos para los fetch_*.

La regla: un 404 es una respuesta (la fuente dice que eso no existe) y se
devuelve como None; cualquier otro fallo (sin red, 5xx, tiempo agotado,
contenido ilegible) se reintenta y, si sigue fallando, levanta FetchError.
Así un corte de red nunca se confunde con "ese dato no existe" ni deja los
archivos generados a medias: los scripts reúnen los FetchError, los cuentan y
terminan con error antes de escribir nada.
"""
import json
import time
import urllib.error
import urllib.request

UA = 'poke-td/1.0'
RETRY_WAIT = 2.0          # segundos; se multiplica por el nº de intento (las pruebas lo ponen a 0)


class FetchError(Exception):
    """No se pudo bajar algo tras los reintentos."""


def get_bytes(url, retries=4, timeout=60, parse=None):
    """Bytes de `url` (o parse(bytes) si se da; un fallo al interpretarlos
    también se reintenta). None si la fuente responde 404."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            return parse(data) if parse else data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except Exception as e:
            last = e
        if attempt + 1 < retries:
            time.sleep(RETRY_WAIT * (attempt + 1))
    raise FetchError(f'{url} -> {last!r}')


def get_json(url, retries=4, timeout=60):
    return get_bytes(url, retries, timeout, parse=json.loads)
