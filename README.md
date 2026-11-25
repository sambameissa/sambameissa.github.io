# sambameissa.github.io

Portfolio de Meissa Ndione Samba — https://sambameissa.github.io/

| Chemin | Contenu |
|---|---|
| `/` | Portfolio (page d'attente pour l'instant) |
| `/xamsql/` | XamSQL, plateforme d'entraînement SQL — **fichiers générés, ne pas modifier ici** |
| `/iqra/` | Iqra, apprendre à lire le Coran — **fichiers générés, ne pas modifier ici** |

`xamsql/` et `iqra/` sont produits depuis le dépôt privé `sambameissa/xamsql` par `npm run build:pages`
(XamSQL) et `npm run build:pages -w apps/iqra` (Iqra).
`404.html` renvoie les adresses `/xamsql/...` et `/iqra/...` vers l'application (liens directs) : en cas de
nouvelle page 404 pour le portfolio, garder son script en tête. `.nojekyll` désactive Jekyll.
