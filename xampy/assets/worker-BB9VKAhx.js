var c=`"""
XamPy — exécution et correction du code de l'élève.

Ce module tourne dans le navigateur (Pyodide, dans un worker) et dans les tests
(CPython + pandas). Il ne dépend que de la bibliothèque standard ; pandas et numpy
sont importés seulement s'ils sont disponibles.

Conventions :
- les fichiers de données sont dans le dossier « data/ » du répertoire courant ;
- dans un exercice, la réponse est la variable « resultat » ;
- pd et np sont déjà importés (comme dans la plupart des notebooks).
"""

from __future__ import annotations

import ast
import contextlib
import difflib
import io
import json
import math
import os
import re
import traceback

try:  # pandas et numpy sont facultatifs (module « Python pour la donnée »)
    import numpy as np
    import pandas as pd
except Exception:  # pragma: no cover
    np = None
    pd = None

FILENAME = "<ton code>"
MAX_ROWS = 200
MAX_TEXT = 20000


# --------------------------------------------------------------------- affichage


def _cell(v):
    """Valeur JSON pour une cellule de tableau."""
    if v is None:
        return None
    if np is not None:
        if isinstance(v, np.generic):
            v = v.item()
    if pd is not None:
        try:
            if v is pd.NA or v is pd.NaT:
                return None
        except Exception:
            pass
        if isinstance(v, pd.Timestamp):
            return v.isoformat(sep=" ") if (v.hour or v.minute or v.second) else v.date().isoformat()
        if isinstance(v, pd.Timedelta):
            return str(v)
    if isinstance(v, float):
        if math.isnan(v):
            return None
        if math.isinf(v):
            return "inf" if v > 0 else "-inf"
        return v
    if isinstance(v, (bool, int, str)):
        return v
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)


def show(value):
    """Représentation à afficher : tableau pour un DataFrame / une Series, texte sinon."""
    if pd is not None and isinstance(value, (pd.DataFrame, pd.Series)):
        typ = "Series" if isinstance(value, pd.Series) else "DataFrame"
        df = value.to_frame(name=value.name if value.name is not None else "valeur") if typ == "Series" else value
        idx = df.index
        default = isinstance(idx, pd.RangeIndex) and idx.start == 0 and idx.step == 1
        head = df.head(MAX_ROWS)
        index = None
        if not default:
            index = [_cell(x) if not isinstance(x, tuple) else " | ".join(str(_cell(y)) for y in x) for x in head.index]
        name = idx.name if idx.name is not None else (" | ".join(str(n) for n in idx.names) if any(n is not None for n in idx.names) else None)
        return {
            "kind": "frame",
            "type": typ,
            "columns": [" | ".join(map(str, c)) if isinstance(c, tuple) else str(c) for c in df.columns],
            "dtypes": [str(t) for t in df.dtypes],
            "index": index,
            "indexName": None if name is None else str(name),
            "rows": [[_cell(v) for v in row] for row in head.itertuples(index=False, name=None)],
            "total": int(len(df)),
        }
    if value is None:
        return {"kind": "text", "text": "None"}
    if np is not None and isinstance(value, np.generic):
        value = value.item()  # np.float64(3.5) -> 3.5 : affiché comme un nombre Python
    try:
        text = repr(value)
    except Exception as e:  # pragma: no cover
        text = f"<objet non affichable : {e}>"
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + " …"
    return {"kind": "text", "text": text, "type": type(value).__name__}


# --------------------------------------------------------------------- exécution


def new_namespace():
    ns = {"__name__": "__main__"}
    if pd is not None:
        ns["pd"] = pd
        ns["np"] = np
    return ns


class _Out(io.StringIO):
    def write(self, s):
        if self.tell() > MAX_TEXT:
            return len(s)
        return super().write(s)


def execute(code: str, ns: dict) -> dict:
    """Exécute le code dans ns. Comme un notebook, affiche la valeur de la dernière ligne si c'est une expression."""
    out = _Out()
    display = None
    try:
        tree = ast.parse(code, FILENAME, "exec")
    except SyntaxError as e:
        return {"ok": False, "stdout": "", "display": None, "error": explain_error(e, ns, code)}
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(compile(tree, FILENAME, "exec"), ns)
            if last is not None:
                value = eval(compile(last, FILENAME, "eval"), ns)
                if value is not None:
                    display = show(value)
    except (Exception, SystemExit) as e:  # noqa: BLE001 — on affiche toute erreur à l'élève
        return {"ok": False, "stdout": out.getvalue(), "display": None, "error": explain_error(e, ns, code)}
    return {"ok": True, "stdout": out.getvalue(), "display": display, "error": None}


def run(code: str) -> str:
    """Bac à sable et exemples de leçon : exécute dans un espace neuf. Renvoie du JSON."""
    ns = new_namespace()
    res = execute(code, ns)
    if res["ok"] and res["display"] is None and "resultat" in ns:
        res["display"] = show(ns["resultat"])
    return json.dumps(res, ensure_ascii=False)


# --------------------------------------------------------------------- erreurs expliquées


def _line_of(e: BaseException) -> int | None:
    if isinstance(e, SyntaxError) and e.filename == FILENAME:
        return e.lineno
    tb = traceback.extract_tb(e.__traceback__)
    lines = [f.lineno for f in tb if f.filename == FILENAME]
    return lines[-1] if lines else None


def _frames(ns):
    if pd is None:
        return []
    return [(k, v) for k, v in ns.items() if isinstance(v, pd.DataFrame) and not k.startswith("_")]


def _closest(word: str, candidates) -> str | None:
    cands = [c for c in dict.fromkeys(str(c) for c in candidates)]
    low = {c.lower(): c for c in cands}
    if word.lower() in low and low[word.lower()] != word:
        return low[word.lower()]
    m = difflib.get_close_matches(word, cands, n=1, cutoff=0.72)
    return m[0] if m else None


PYSPARK_LIKE = {
    "groupBy": "groupby",
    "orderBy": "sort_values",
    "sort": "sort_values",
    "withColumn": "assign (ou df['nouvelle'] = …)",
    "withColumnRenamed": "rename(columns={'ancien': 'nouveau'})",
    "filter": "df[df['col'] > valeur] ou df.query('col > valeur')",
    "select": "df[['col1', 'col2']]",
    "where": "df[condition]",
    "show": "print(df) ou simplement df en dernière ligne",
    "distinct": "drop_duplicates()",
    "dropDuplicates": "drop_duplicates()",
    "count": "len(df) ou df['col'].count()",
    "join": "merge(autre, on='cle')",
    "toPandas": "(c'est déjà un DataFrame pandas)",
    "length": "len(df)",
    "size()": "len(df)",
    "append": "pd.concat([df1, df2])",
    "isNull": "isna()",
    "isnull()": "isna()",
}

SYNTAX_FR = [
    (r"expected ':'", "Il manque « : » à la fin de la ligne (après if, for, while, def, else…)."),
    (r"unterminated string literal", "Une chaîne de caractères n'est pas fermée : il manque un guillemet."),
    (r"unterminated triple-quoted string", "Une chaîne entre triples guillemets n'est pas fermée."),
    (r"'(.)' was never closed", "La parenthèse ou le crochet « {0} » n'est jamais fermé."),
    (r"unmatched '(.)'", "« {0} » ferme quelque chose qui n'a pas été ouvert."),
    (r"closing parenthesis '(.)' does not match opening parenthesis '(.)'", "« {0} » ne correspond pas à « {1} » ouvert plus tôt."),
    (r"unexpected indent", "Indentation inattendue : cette ligne est décalée alors qu'elle ne devrait pas l'être."),
    (r"expected an indented block", "Un bloc indenté est attendu ici (après « : », la ligne suivante doit être décalée de 4 espaces)."),
    (r"unindent does not match", "L'indentation de cette ligne ne correspond à aucun niveau précédent : aligne-la avec le bloc voulu."),
    (r"invalid syntax\\. Perhaps you forgot a comma", "Syntaxe invalide : il manque peut-être une virgule."),
    (r"invalid syntax\\. Maybe you meant '==' or ':=' instead of '='", "« = » sert à affecter une valeur ; pour comparer, utilise « == »."),
    (r"cannot assign to", "On ne peut pas affecter une valeur à cette expression (à gauche du « = »)."),
    (r"invalid decimal literal", "Nombre mal écrit : en Python, la virgule décimale est un point (3.5) et un nom ne commence pas par un chiffre."),
    (r"Missing parentheses in call to 'print'", "En Python 3, print est une fonction : print(…)."),
    (r"invalid character '(.)'", "Caractère invalide « {0} » : souvent un guillemet typographique (’ « ») ou un tiret long collé depuis un traitement de texte."),
    (r"invalid syntax", "Syntaxe invalide."),
]


def explain_error(e: BaseException, ns: dict, code: str = "") -> dict:
    """Erreur Python → message en français, piste, ligne concernée."""
    typ = type(e).__name__
    raw = str(e)
    line = _line_of(e)
    msg, hint = None, None

    if isinstance(e, SyntaxError):
        detail = e.msg or ""
        for pat, fr in SYNTAX_FR:
            m = re.search(pat, detail)
            if m:
                msg = fr.format(*m.groups())
                break
        msg = msg or f"Erreur de syntaxe : {detail}"
        if isinstance(e, IndentationError) and not hint:
            hint = "En Python, l'indentation fait partie de la syntaxe : 4 espaces par niveau, sans mélanger tabulations et espaces."
        raw = detail
    elif isinstance(e, NameError):
        m = re.search(r"name '(\\w+)' is not defined", raw)
        name = m.group(1) if m else "?"
        msg = f"Le nom « {name} » n'est pas défini."
        cols = [c for _, df in _frames(ns) for c in df.columns]
        near = _closest(name, [k for k in ns if not k.startswith("__")] + list(__builtins__ if isinstance(__builtins__, dict) else dir(__builtins__)))
        if name in map(str, cols):
            hint = f"« {name} » est une colonne : écris df['{name}'] (avec le nom de ton DataFrame)."
        elif near:
            hint = f"Tu voulais peut-être dire « {near} » ?"
        else:
            hint = "Une variable doit être créée (par une affectation) avant d'être utilisée. Vérifie l'orthographe, et que la ligne qui la crée est bien exécutée avant."
    elif isinstance(e, KeyError):
        key = e.args[0] if e.args else None
        frames = _frames(ns)
        cols = [str(c) for _, df in frames for c in df.columns]
        missing = re.fullmatch(r"\\[(.*)\\] not (?:in index|found in axis)", key) if isinstance(key, str) else None
        if missing and frames:
            names = re.findall(r"'([^']*)'", missing.group(1)) or [missing.group(1)]
            msg = ("La colonne « " + names[0] + " » n'existe pas.") if len(names) == 1 else ("Les colonnes " + ", ".join(f"« {n} »" for n in names) + " n'existent pas.")
            fixes = [f"« {n} » → « {near} »" for n in names if (near := _closest(n, cols))]
            hint = ("Tu voulais peut-être dire : " + ", ".join(fixes) + ".") if fixes else f"Colonnes disponibles : {', '.join(dict.fromkeys(cols))[:300]}."
            if "found in axis" in key and all(n in cols for n in names):
                msg = f"« {names[0]} » est une colonne, mais drop cherche par défaut une ligne."
                hint = "Pour supprimer une colonne : df.drop(columns=[\\"" + names[0] + "\\"])."
        elif isinstance(key, tuple) and frames and all(isinstance(k, str) for k in key):
            msg = "Plusieurs noms de colonnes entre simples crochets sont lus comme un seul nom : " + repr(key) + "."
            hint = "Pour plusieurs colonnes, passe une liste : df[[" + ", ".join(repr(k) for k in key) + "]] (doubles crochets)."
        elif isinstance(key, str) and frames:
            msg = f"La colonne (ou clé) « {key} » n'existe pas."
            near = _closest(key, cols)
            if near:
                hint = f"Tu voulais peut-être dire « {near} » ?"
            else:
                shown = ", ".join(dict.fromkeys(cols))
                hint = f"Colonnes disponibles : {shown[:300]}."
            if isinstance(key, str) and "," in key:
                hint = "Pour plusieurs colonnes, passe une liste : df[['col1', 'col2']] (doubles crochets)."
        else:
            msg = f"La clé {key!r} n'existe pas (dictionnaire ou index)."
            hint = "Vérifie l'orthographe et la casse de la clé ; dict.get(cle, defaut) évite l'erreur."
    elif isinstance(e, AttributeError):
        m = re.search(r"'(\\w+)' object has no attribute '(\\w+)'", raw)
        if m:
            obj, attr = m.groups()
            msg = f"Un objet {obj} n'a pas d'attribut ni de méthode « {attr} »."
            frames = _frames(ns)
            cols = [str(c) for _, df in frames for c in df.columns]
            if attr in PYSPARK_LIKE and obj in ("DataFrame", "Series", "DataFrameGroupBy", "SeriesGroupBy"):
                hint = f"En pandas, on écrit : {PYSPARK_LIKE[attr]}."
            elif attr in cols:
                hint = f"Pour une colonne dont le nom pose problème, préfère la notation df['{attr}']."
            elif obj in ("NoneType",):
                hint = "La variable vaut None : une méthode comme sort_values(inplace=True), ou une fonction sans return, ne renvoie rien."
            else:
                target = {"DataFrame": "DataFrame", "Series": "Series"}.get(obj)
                pool = dir(getattr(pd, target)) if (pd is not None and target) else []
                if obj == "str":
                    pool = dir(str)
                elif obj == "list":
                    pool = dir(list)
                elif obj == "dict":
                    pool = dir(dict)
                near = _closest(attr, [p for p in pool if not p.startswith("_")])
                if near:
                    hint = f"Tu voulais peut-être dire « {near} » ?"
                if obj == "Series" and attr in ("lower", "upper", "strip", "replace", "split", "contains", "startswith"):
                    hint = f"Sur une colonne de texte, passe par .str : df['col'].str.{attr}(…)."
                if obj == "Series" and attr in ("year", "month", "day", "dayofweek"):
                    hint = f"Sur une colonne de dates, passe par .dt : df['col'].dt.{attr} (après pd.to_datetime si besoin)."
        else:
            msg = f"Attribut introuvable : {raw}"
    elif isinstance(e, TypeError):
        if "object is not callable" in raw:
            m = re.search(r"'(\\w+)' object is not callable", raw)
            msg = f"On appelle avec des parenthèses quelque chose qui n'est pas une fonction ({m.group(1) if m else 'objet'})."
            hint = "Pour une colonne, ce sont des crochets : df['col'], pas df('col'). Une variable a peut-être aussi remplacé le nom d'une fonction (sum = …, list = …)."
        elif "unsupported operand type" in raw or "can only concatenate str" in raw or "must be str, not" in raw:
            msg = "Opération entre deux types incompatibles (texte et nombre, par exemple)."
            hint = "Convertis d'abord : int(x), float(x), str(x), ou pd.to_numeric(df['col']) pour une colonne."
        elif "takes" in raw and "positional argument" in raw:
            msg = "Une fonction reçoit un mauvais nombre d'arguments."
            hint = "Compare l'appel avec la définition de la fonction (def …) : même nombre d'arguments, dans le même ordre."
        elif "missing" in raw and "required positional argument" in raw:
            msg = "Il manque un argument dans l'appel d'une fonction."
            hint = raw
        elif "unhashable type" in raw:
            msg = "Une liste ou un dictionnaire ne peut pas servir de clé (de dictionnaire, d'ensemble, ou de groupby)."
            hint = "Utilise un tuple à la place d'une liste, ou une colonne au lieu d'une liste de valeurs."
        elif "not subscriptable" in raw:
            msg = "On utilise des crochets [ ] sur un objet qui n'en accepte pas."
            hint = "Une fonction s'appelle avec des parenthèses : len(x), pas len[x]."
        elif "'<' not supported between" in raw or "'>' not supported between" in raw:
            msg = "Comparaison impossible entre deux types différents (texte et nombre, par exemple)."
            hint = "Vérifie le type de la colonne (df.dtypes) et convertis si besoin."
        else:
            msg = f"Erreur de type : {raw}"
    elif isinstance(e, ValueError):
        if "truth value of a" in raw and "ambiguous" in raw:
            msg = "Une condition porte sur toute une colonne : Python ne sait pas si elle est « vraie » dans son ensemble."
            hint = "Pour combiner des conditions pandas, utilise & (et), | (ou), ~ (non) avec des parenthèses : df[(df['a'] > 1) & (df['b'] == 'x')]. Pour tester un ensemble : .any() ou .all()."
        elif "could not convert string to float" in raw or "invalid literal for int()" in raw or "Unable to parse string" in raw:
            msg = "Une valeur texte ne peut pas être convertie en nombre."
            hint = "Nettoie d'abord (espaces, virgule décimale « , » → « . », valeurs « N/A »), ou utilise pd.to_numeric(col, errors='coerce') pour obtenir NaN à la place."
        elif "Length of values" in raw and "does not match length of index" in raw:
            msg = "Le nombre de valeurs ne correspond pas au nombre de lignes du DataFrame."
            hint = "Une nouvelle colonne doit avoir une valeur par ligne (ou une seule valeur, répétée)."
        elif "You are trying to merge on" in raw:
            msg = "Les colonnes de jointure n'ont pas le même type dans les deux DataFrames."
            hint = "Convertis l'une des deux (astype(int) ou astype(str)) avant le merge."
        elif "time data" in raw or "doesn't match format" in raw:
            msg = "Une date ne correspond pas au format attendu."
            hint = "Précise le format (pd.to_datetime(col, format='%d/%m/%Y')) ou utilise errors='coerce' pour obtenir NaT sur les valeurs invalides."
        else:
            msg = f"Valeur incorrecte : {raw}"
    elif isinstance(e, FileNotFoundError):
        files = sorted(f for f in os.listdir("data") if f != "content.json") if os.path.isdir("data") else []
        msg = f"Fichier introuvable : {getattr(e, 'filename', None) or raw}."
        hint = f"Les fichiers disponibles sont dans le dossier data/ : {', '.join(files)}." if files else "Vérifie le chemin du fichier."
    elif isinstance(e, ModuleNotFoundError):
        msg = f"Le module « {e.name} » n'est pas disponible ici."
        hint = "XamPy fournit la bibliothèque standard, pandas et numpy (d'autres bibliothèques arrivent avec les modules suivants)."
    elif isinstance(e, ZeroDivisionError):
        msg = "Division par zéro."
        hint = "Vérifie le dénominateur avant de diviser (if denominateur != 0)."
    elif isinstance(e, IndexError):
        msg = "Position hors limites : l'élément demandé n'existe pas."
        hint = "Les positions commencent à 0 : le dernier élément d'une liste de n éléments est à la position n - 1 (ou -1)."
    elif isinstance(e, RecursionError):
        msg = "Une fonction s'appelle elle-même sans fin."
        hint = "Vérifie la condition d'arrêt."
    elif isinstance(e, SystemExit):
        msg = "Le code a appelé exit() : rien de plus ne s'exécute."
    else:
        msg = f"{typ} : {raw}"

    return {"type": typ, "raw": raw, "message": msg, "hint": hint, "line": line}


# --------------------------------------------------------------------- comparaison


def _norm_value(v):
    v = _cell(v)
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        return float(v)
    if isinstance(v, int) and not isinstance(v, bool):
        return float(v)
    return v


def _same(a, b, tol=1e-6) -> bool:
    a, b = _norm_value(a), _norm_value(b)
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, float) and isinstance(b, float):
        return math.isclose(a, b, rel_tol=tol, abs_tol=tol)
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    return a == b


def _rounding_only(a, b) -> bool:
    """Écart dû seulement à un arrondi (au centième près, ou 0,1 % près)."""
    a, b = _norm_value(a), _norm_value(b)
    if not (isinstance(a, float) and isinstance(b, float)) or math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-6):
        return False
    return math.isclose(a, b, abs_tol=0.051) or math.isclose(a, b, rel_tol=1e-3)


def _as_frame(obj):
    """DataFrame comparable : index significatif remis en colonne, index 0..n-1."""
    if isinstance(obj, pd.Series):
        obj = obj.to_frame(name=obj.name if obj.name is not None else "valeur")
    idx = obj.index
    meaningful = not (pd.api.types.is_integer_dtype(idx.dtype) and all(n is None for n in idx.names))
    if isinstance(idx, pd.MultiIndex) or meaningful:
        obj = obj.reset_index()
    else:
        obj = obj.reset_index(drop=True)
    obj.columns = [" | ".join(map(str, c)) if isinstance(c, tuple) else str(c) for c in obj.columns]
    return obj


def _rows(df):
    return [tuple(_norm_value(v) for v in r) for r in df.itertuples(index=False, name=None)]


def _key(row):
    return tuple((0, "") if v is None else (1, round(v, 6)) if isinstance(v, float) else (2, str(v)) for v in row)


def compare(got, expected, spec: dict | None = None) -> dict:
    """Score 1 (juste), 0.5 (presque) ou 0, avec les diagnostics en français."""
    spec = spec or {}
    diags = []

    def verdict(score, *items):
        return {"score": score, "diagnostics": [d for d in (diags + list(items)) if d]}

    def d(message, hint=None):
        return {"message": message, "hint": hint}

    if got is None and expected is not None:
        return verdict(0, d("resultat vaut None.", "Une méthode qui modifie sur place (liste.sort(), liste.append(), df.sort_values(…, inplace=True)) ou une fonction sans return renvoie None : garde l'objet lui-même, ou ajoute return."))

    is_pd = pd is not None and isinstance(expected, (pd.DataFrame, pd.Series))
    if is_pd:
        if not isinstance(got, (pd.DataFrame, pd.Series)):
            what = type(got).__name__
            if isinstance(got, (int, float)) and not isinstance(got, bool):
                return verdict(0, d(f"On attend un tableau ({type(expected).__name__}), et resultat est un nombre.", "Garde le DataFrame entier au lieu d'extraire une seule valeur."))
            return verdict(0, d(f"On attend un {type(expected).__name__} pandas, et resultat est de type {what}."))
        exp = _as_frame(expected)
        mine = _as_frame(got)
        ecols, mcols = list(exp.columns), list(mine.columns)
        missing = [c for c in ecols if c not in mcols]
        extra = [c for c in mcols if c not in ecols]
        if missing and len(ecols) == len(mcols) and len(exp) == len(mine):
            # Mêmes données, autres noms : comparaison par position.
            mine_pos = mine.copy()
            mine_pos.columns = ecols
            if sorted(_rows(mine_pos), key=_key) == sorted(_rows(exp), key=_key) or _rows(mine_pos) == _rows(exp):
                return verdict(0.5, d(f"Les valeurs sont justes, mais les noms de colonnes diffèrent : attendu {', '.join(ecols)} ; obtenu {', '.join(mcols)}.", "Renomme avec rename(columns={…}), ou nomme le résultat de l'agrégation (agg(nom=('col', 'sum')))."))
        if missing:
            return verdict(0, d(f"Colonne{'s' if len(missing) > 1 else ''} manquante{'s' if len(missing) > 1 else ''} : {', '.join(missing)}.", f"Le résultat attendu a les colonnes : {', '.join(ecols)}."))
        if extra:
            diags.append(d(f"Colonne{'s' if len(extra) > 1 else ''} en trop : {', '.join(extra)}.", f"Garde seulement : {', '.join(ecols)}."))
            mine = mine[ecols]
        else:
            mine = mine[ecols]
        if len(mine) != len(exp):
            more = len(mine) > len(exp)
            return verdict(
                0,
                d(
                    f"Ton résultat a {len(mine)} ligne{'s' if len(mine) > 1 else ''}, {len(exp)} attendue{'s' if len(exp) > 1 else ''}.",
                    "Un filtre manque, ou des doublons restent (drop_duplicates) ?" if more else "Le filtre est trop strict, ou une jointure élimine des lignes (how='left' ?).",
                ),
            )
        er, mr = _rows(exp), _rows(mine)
        ordered = spec.get("ordered", False)
        same_rows = all(all(_same(a, b) for a, b in zip(x, y)) for x, y in zip(sorted(mr, key=_key), sorted(er, key=_key)))
        if ordered:
            in_order = all(all(_same(a, b) for a, b in zip(x, y)) for x, y in zip(mr, er))
            if in_order:
                return verdict(0.5 if extra else 1)
            if same_rows:
                return verdict(0.5, d("Les bonnes lignes, mais pas dans l'ordre demandé.", "Trie avec sort_values(…, ascending=…) selon l'énoncé."))
        elif same_rows:
            return verdict(0.5 if extra else 1)
        # Valeurs différentes : quelles colonnes ?
        a, b = (mr, er) if ordered else (sorted(mr, key=_key), sorted(er, key=_key))
        bad = [ecols[j] for j in range(len(ecols)) if any(not _same(x[j], y[j]) for x, y in zip(a, b))]
        rounding = all(_rounding_only(x[j], y[j]) or _same(x[j], y[j]) for x, y in zip(a, b) for j in range(len(ecols)))
        if rounding:
            return verdict(0.5, d("Les valeurs sont justes à l'arrondi près.", "Vérifie l'arrondi demandé : round(2) sur le résultat."))
        return verdict(0, d(f"Bon nombre de lignes, mais les valeurs de {', '.join(bad) or 'certaines colonnes'} ne correspondent pas.", "Compare une ligne de ton résultat avec l'attendu : calcul, filtre ou clé de jointure ?"))

    # Valeurs Python simples
    if isinstance(expected, bool) or isinstance(got, bool):
        return verdict(1 if got == expected else 0, None if got == expected else d(f"Résultat : {got!r} ; attendu : {expected!r}."))
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        if pd is not None and isinstance(got, (pd.Series, pd.DataFrame)) and got.size == 1:
            got = got.squeeze()
        if np is not None and isinstance(got, np.generic):
            got = got.item()
        if not isinstance(got, (int, float)):
            return verdict(0, d(f"On attend un nombre, et resultat est de type {type(got).__name__}.", "Extrais la valeur : .sum(), len(…), .iloc[0]…"))
        if _same(got, expected):
            return verdict(1)
        if _rounding_only(got, expected):
            return verdict(0.5, d(f"Presque : {got!r} au lieu de {expected!r} (arrondi).", "Arrondis comme demandé : round(x, 2)."))
        return verdict(0, d(f"Ton résultat vaut {got!r}, ce n'est pas la valeur attendue.", "Relis l'énoncé : quelles lignes compter, quelle colonne additionner ?"))
    if isinstance(expected, str):
        if isinstance(got, str) and got.strip() == expected.strip():
            return verdict(1)
        if isinstance(got, str) and got.strip().lower() == expected.strip().lower():
            return verdict(0.5, d("Presque : seules les majuscules / minuscules diffèrent."))
        return verdict(0, d(f"Ton résultat vaut {got!r} ; attendu : un texte de {len(expected)} caractères.", "Vérifie la valeur exacte demandée (espaces, majuscules)."))
    if isinstance(expected, (list, tuple)):
        if not isinstance(got, (list, tuple)):
            if np is not None and pd is not None and isinstance(got, (np.ndarray, pd.Series, pd.Index)):
                got = list(got)
            else:
                return verdict(0, d(f"On attend une liste, et resultat est de type {type(got).__name__}."))
        if len(got) != len(expected):
            return verdict(0, d(f"Ta liste contient {len(got)} élément{'s' if len(got) > 1 else ''}, {len(expected)} attendu{'s' if len(expected) > 1 else ''}."))
        if all(compare(g, e, spec)["score"] == 1 for g, e in zip(got, expected)):
            return verdict(1)
        if not spec.get("ordered", True):
            try:
                if sorted(map(repr, map(_norm_value, got))) == sorted(map(repr, map(_norm_value, expected))):
                    return verdict(1)
            except Exception:
                pass
        if sorted(map(repr, got)) == sorted(map(repr, expected)):
            return verdict(0.5, d("Les bons éléments, mais pas dans l'ordre attendu.", "sorted(…) ou l'ordre de parcours ?"))
        return verdict(0, d("Certains éléments de la liste ne correspondent pas à l'attendu."))
    if isinstance(expected, set):
        if not isinstance(got, (set, frozenset)):
            got = set(got) if isinstance(got, (list, tuple)) else got
        ok = got == expected
        return verdict(1 if ok else 0, None if ok else d("L'ensemble ne contient pas exactement les éléments attendus."))
    if isinstance(expected, dict):
        if not isinstance(got, dict):
            return verdict(0, d(f"On attend un dictionnaire, et resultat est de type {type(got).__name__}."))
        mk = [k for k in expected if k not in got]
        xk = [k for k in got if k not in expected]
        if mk or xk:
            parts = []
            if mk:
                parts.append(f"clés manquantes : {', '.join(map(repr, mk))}")
            if xk:
                parts.append(f"clés en trop : {', '.join(map(repr, xk))}")
            return verdict(0, d("Les clés du dictionnaire ne correspondent pas (" + " ; ".join(parts) + ")."))
        bad = [k for k in expected if compare(got[k], expected[k], spec)["score"] < 1]
        if not bad:
            return verdict(1)
        return verdict(0, d(f"Les valeurs ne correspondent pas pour : {', '.join(map(repr, bad))}."))
    ok = got == expected
    return verdict(1 if ok else 0, None if ok else d("Le résultat ne correspond pas à l'attendu."))


# --------------------------------------------------------------------- correction


def check(code: str, solution: str, spec_json: str = "{}") -> str:
    """Corrige le code de l'élève en le comparant à la solution, exécutée dans un espace séparé. Renvoie du JSON."""
    spec = json.loads(spec_json or "{}")
    ref_ns = new_namespace()
    ref = execute(solution, ref_ns)
    if not ref["ok"] or "resultat" not in ref_ns:  # pragma: no cover — vérifié par les tests du contenu
        return json.dumps({"status": "ko", "score": 0, "diagnostics": [{"message": "Erreur interne : la solution de référence ne s'exécute pas.", "hint": None}], "stdout": "", "got": None, "expected": None, "error": ref["error"]}, ensure_ascii=False)
    expected = ref_ns["resultat"]
    ns = new_namespace()
    res = execute(code, ns)
    base = {"stdout": res["stdout"], "expected": show(expected), "display": res["display"]}
    if not res["ok"]:
        return json.dumps({**base, "status": "ko", "score": 0, "diagnostics": [], "got": None, "error": res["error"]}, ensure_ascii=False)
    if "resultat" not in ns:
        diag = {"message": "Ta réponse doit être rangée dans une variable nommée resultat.", "hint": "Termine par une ligne du type : resultat = …"}
        return json.dumps({**base, "status": "ko", "score": 0, "diagnostics": [diag], "got": None, "error": None}, ensure_ascii=False)
    got = ns["resultat"]
    try:
        v = compare(got, expected, spec)
    except Exception as e:  # pragma: no cover
        v = {"score": 0, "diagnostics": [{"message": f"Comparaison impossible : {e}", "hint": None}]}
    # Pièges repérés dans le code (n'influencent pas le score).
    if v["score"] < 1:
        v["diagnostics"] += code_hints(code)
    status = "ok" if v["score"] == 1 else "partial" if v["score"] == 0.5 else "ko"
    return json.dumps({**base, "status": status, "score": v["score"], "diagnostics": v["diagnostics"], "got": show(got), "error": None}, ensure_ascii=False)


def code_hints(code: str) -> list:
    hints = []
    flat = re.sub(r"(['\\"]).*?\\1", "''", code)
    if re.search(r"\\]\\s*(and|or)\\s*\\(?\\s*\\w+\\[", flat) or re.search(r"\\)\\s+(and|or)\\s+\\(", flat):
        hints.append({"message": "Ton code combine des conditions pandas avec and / or.", "hint": "Sur des colonnes, utilise & et | avec des parenthèses autour de chaque condition."})
    if re.search(r"\\binplace\\s*=\\s*True\\b", flat) and re.search(r"=\\s*\\w+\\.\\w+\\([^)]*inplace\\s*=\\s*True", flat):
        hints.append({"message": "Une méthode appelée avec inplace=True renvoie None : la variable qui reçoit son résultat vaut None.", "hint": "Écris soit df = df.methode(…), soit df.methode(…, inplace=True) sans affectation."})
    if re.search(r"==\\s*None|!=\\s*None|==\\s*np\\.nan|==\\s*float\\(['\\"]nan", flat):
        hints.append({"message": "Comparer avec None ou NaN par == ne marche pas (NaN n'est égal à rien, même pas à lui-même).", "hint": "Utilise isna() / notna() sur une colonne, ou x is None pour une variable."})
    return hints
`;const u="314.0.8",l=`https://cdn.jsdelivr.net/pyodide/v${u}/full/`;let r=null;const s=n=>self.postMessage(n);async function p(n,e){if(r)return;s({id:-1,progress:"Chargement de Python…"});const t=await(await import(`${l}pyodide.mjs`)).loadPyodide({indexURL:l});s({id:-1,progress:"Chargement de pandas…"}),await t.loadPackage(["pandas"]),s({id:-1,progress:"Préparation des données…"}),t.FS.mkdirTree("/home/pyodide/data"),await Promise.all(e.map(async o=>{const a=await fetch(`${n}/data/${o}`);if(!a.ok)throw new Error(`Fichier de données introuvable : ${o}`);t.FS.writeFile(`/home/pyodide/data/${o}`,new Uint8Array(await a.arrayBuffer()))})),t.FS.writeFile("/home/pyodide/xampy_runtime.py",c),t.FS.chdir("/home/pyodide"),t.runPython("import sys; sys.path.insert(0, '/home/pyodide')"),r=t.pyimport("xampy_runtime")}function d(n,...e){if(!r)throw new Error("Python n'est pas prêt");return r[n](...e)}self.onmessage=async n=>{const e=n.data;try{e.type==="init"?(await p(e.base,e.files),s({id:e.id,ok:!0})):e.type==="run"?s({id:e.id,ok:!0,json:d("run",e.code)}):s({id:e.id,ok:!0,json:d("check",e.code,e.solution,JSON.stringify(e.spec))})}catch(i){s({id:e.id,ok:!1,error:i instanceof Error?i.message:String(i)})}};
