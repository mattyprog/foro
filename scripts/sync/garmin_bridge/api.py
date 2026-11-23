"""Accesso alla Garmin Connect Personal API tramite il client Python ufficiale di Garmin.

- token: PersonalApiAuthenticator (POST con 'Authorization: ApiKey <chiave>', JWT valido 24 h);
  la cache del token sta in una cartella temporanea cancellata alla chiusura;
- richieste: GarminPersonalApiClient (GET con bearer), con ritentativi su 429/5xx/rete e un solo
  rinnovo del token su 401;
- gli errori NON contengono mai URL, parametri o testo delle risposte (i log delle Actions sono
  pubblici): solo lo stato HTTP. Le eccezioni originali vengono soppresse (`from None`).
"""

from __future__ import annotations

import logging
import tempfile
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import requests
from garmin_personal_api import GarminPersonalApiClient, GarminPersonalApiError, HttpError, PersonalApiAuthenticator

# Il client ufficiale registra in INFO i path chiamati (con date e id): mai sopra WARNING.
logging.getLogger("garmin_personal_api").setLevel(logging.WARNING)

RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504}
PERMANENT_STATUS = {400, 403, 404, 405, 410, 422}
DEFAULT_TIMEOUT = 30.0


class AuthError(Exception):
    """Chiave rifiutata, scaduta o revocata (la sync si ferma con exit code != 0)."""

    def __init__(self, status: int | None = None):
        super().__init__(f"autenticazione Garmin non riuscita (HTTP {status})" if status else "autenticazione Garmin non riuscita")
        self.status = status


class GarminUnavailableError(Exception):
    """Garmin non raggiungibile al momento (rete o 5xx sul token): si riprova al prossimo giro."""

    def __init__(self, status: int | None = None):
        super().__init__(f"Garmin non raggiungibile (HTTP {status})" if status else "Garmin non raggiungibile")
        self.status = status


class EndpointError(Exception):
    """Un endpoint non ha risposto bene. `permanent`: inutile riprovare (es. 404 file assente)."""

    def __init__(self, status: int | None = None, *, permanent: bool = False):
        super().__init__(f"HTTP {status}" if status else "errore di rete")
        self.status = status
        self.permanent = permanent


class GarminApi:
    def __init__(
        self,
        api_key: str,
        *,
        session: Any = None,
        timeout: float = DEFAULT_TIMEOUT,
        retries: int = 2,
        backoff: tuple[float, ...] = (3.0, 10.0),
        sleep: Callable[[float], None] = time.sleep,
        polite_delay: float = 0.2,
    ) -> None:
        self._key = api_key.strip()
        self._session = session if session is not None else requests.Session()
        self._timeout = timeout
        self._retries = retries
        self._backoff = backoff
        self._sleep = sleep
        self._polite_delay = polite_delay
        self._tmp = tempfile.TemporaryDirectory(prefix="foro-garmin-")
        self.token_cache_path = Path(self._tmp.name) / "bearer-token.json"
        self._auth = PersonalApiAuthenticator(
            timeout=timeout, session=self._session, bearer_token_cache_file=self.token_cache_path
        )
        self._client: GarminPersonalApiClient | None = None
        self.requests_made = 0

    # ------------------------------------------------------------ ciclo di vita

    def __enter__(self) -> GarminApi:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        try:
            self._session.close()
        finally:
            self._tmp.cleanup()

    def _wait(self, attempt: int) -> None:
        self._sleep(self._backoff[min(attempt, len(self._backoff) - 1)])

    # ------------------------------------------------------------ token

    def _obtain_token(self, *, force: bool) -> str:
        for attempt in range(self._retries + 1):
            try:
                self.requests_made += 1
                return self._auth.obtain_token(self._key, force_refresh=force).access_token
            except HttpError as exc:
                status = exc.status_code
                if status in (400, 401, 403):
                    raise AuthError(status) from None
                if status in RETRY_STATUS and attempt < self._retries:
                    self._wait(attempt)
                    continue
                raise GarminUnavailableError(status) from None
            except GarminPersonalApiError:
                # chiave vuota o risposta del token senza JWT valido
                raise AuthError() from None
            except requests.RequestException:
                if attempt < self._retries:
                    self._wait(attempt)
                    continue
                raise GarminUnavailableError() from None
        raise GarminUnavailableError()

    def connect(self) -> None:
        token = self._obtain_token(force=False)
        self._client = GarminPersonalApiClient(token, timeout=self._timeout, session=self._session)

    def _refresh(self) -> None:
        token = self._obtain_token(force=True)
        assert self._client is not None
        self._client.update_bearer_token(token)

    # ------------------------------------------------------------ richieste

    def _call(self, fn: Callable[[GarminPersonalApiClient], Any]) -> Any:
        if self._client is None:
            raise RuntimeError("connect() non chiamato")
        refreshed = False
        attempt = 0
        while True:
            try:
                self.requests_made += 1
                return fn(self._client)
            except HttpError as exc:
                status = exc.status_code
                if status == 401:
                    if refreshed:
                        raise AuthError(401) from None
                    refreshed = True
                    self._refresh()
                    continue
                if status in RETRY_STATUS and attempt < self._retries:
                    self._wait(attempt)
                    attempt += 1
                    continue
                raise EndpointError(status, permanent=status in PERMANENT_STATUS) from None
            except GarminPersonalApiError:
                raise EndpointError(None, permanent=True) from None
            except requests.RequestException:
                if attempt < self._retries:
                    self._wait(attempt)
                    attempt += 1
                    continue
                raise EndpointError(None) from None
            except ValueError:  # JSON non valido
                raise EndpointError(None) from None

    def get_json(self, path: str, params: Mapping[str, Any] | None = None) -> Any:
        return self._call(lambda c: c.get(path, params=params))

    def download_activity(self, activity_id: str) -> bytes:
        if self._polite_delay:
            self._sleep(self._polite_delay)
        return self._call(lambda c: c.download_activity(activity_id))
