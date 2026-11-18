# Pryse — notas en wenke

Ruan se werkvouer vir prysbesluite. Hier kom notas, idees en "dink hieraan"-punte; die finale pryse self kom in `backend/config/app-pricing.js` (tans nog leeg — die "Manage apps"-venster sê dan vir die kliënt dat Lorenco die prys sal bevestig).

| Lêer | Onderwerp |
|---|---|
| [BOTS_EN_BILLIKE_GEBRUIK.md](BOTS_EN_BILLIKE_GEBRUIK.md) | Eksterne AI-bots (bv. Grok) as gebruikers, billike-gebruik-limiete, en wat dit vir pryse beteken |

Hoe pryse in die stelsel werk (vandag):
- Per app: `text` (wat die kliënt sien en aanvaar), `billing` (bv. "monthly in advance"), en vir fakture `amount` (basis per maand, ex BTW) en `perEmployee` (Paytime, × aktiewe werknemers).
- Fakture word as konsepte in maatskappy 40 se Ledger Leo gemaak (Platform Control → Invoice). Toets- en demo-maatskappye word nooit gefaktureer nie.
