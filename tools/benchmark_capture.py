#!/usr/bin/env python3
"""Standalone capture preparation: never imports the application or writes its DB."""
import argparse
import datetime
import ipaddress
import json
import math
import os
import re
import secrets
import signal
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class SafeError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def clean_text(value):
    text = value if isinstance(value, str) else ""
    text = re.sub(r"(?i)\b(?:[a-z][a-z0-9+.-]*://|magnet:)\S+", "[URL]", text)
    text = re.sub(r"(?i)\b(?:apikey|api[_-]?key|token|passkey)\s*[:=]\s*\S+", "[KEY]", text)
    text = re.sub(r"(?i)\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b", "[ID]", text)
    text = re.sub(r"(?:[A-Za-z]:\\|/)(?:[^\s/\\]+[/\\])+[^\s]*", "[PATH]", text)
    return re.sub(r"[\x00-\x1f\x7f]", " ", text).strip()[:500]


def validate_manifest(value):
    if not isinstance(value, dict) or set(value) != {"version", "cases"} or value.get("version") != 1:
        raise SafeError("invalid_manifest")
    if not isinstance(value["cases"], list) or not 1 <= len(value["cases"]) <= 12:
        raise SafeError("invalid_cases")
    count, seen = 0, set()
    for case in value["cases"]:
        if not isinstance(case, dict) or set(case) != {"id", "kind", "title", "queries"}:
            raise SafeError("invalid_case")
        if case["kind"] not in ("anime", "tv", "movie") or not isinstance(case["id"], str) or not re.fullmatch(r"[a-z0-9-]{1,80}", case["id"]) or case["id"] in seen:
            raise SafeError("invalid_case")
        if not isinstance(case["title"], str) or not case["title"] or case["title"] != clean_text(case["title"]):
            raise SafeError("invalid_title")
        seen.add(case["id"])
        if not isinstance(case["queries"], list) or not 1 <= len(case["queries"]) <= 6:
            raise SafeError("invalid_queries")
        for q in case["queries"]:
            if not isinstance(q, dict) or set(q) != {"family", "query", "categories"}:
                raise SafeError("invalid_query")
            if not isinstance(q["family"], str) or not re.fullmatch(r"[a-z0-9-]{1,60}", q["family"]):
                raise SafeError("invalid_family")
            if not isinstance(q["query"], str) or not 1 <= len(q["query"]) <= 300 or q["query"] != clean_text(q["query"]):
                raise SafeError("invalid_query")
            cats = q["categories"]
            if not isinstance(cats, list) or not 1 <= len(cats) <= 4 or any(type(c) is not int or not 1000 <= c <= 8999 for c in cats):
                raise SafeError("invalid_categories")
            count += 1
    if count > 72:
        raise SafeError("search_limit")
    return {"searches": count, "cases": len(seen)}


class IdentityMap:
    """Union raw identifiers only in memory; random tokens cannot reveal hashes."""
    def __init__(self):
        self.raw, self.parent = {}, {}

    def canonical(self, token):
        parent = self.parent.get(token, token)
        if parent != token:
            self.parent[token] = self.canonical(parent)
        return self.parent.get(token, token)

    def identify(self, indexer, guid, infohash):
        keys = [("guid", indexer, guid)] if isinstance(guid, str) and guid else []
        if isinstance(infohash, str) and infohash:
            keys.append(("hash", infohash.lower()))
        tokens = [self.canonical(self.raw[k]) for k in keys if k in self.raw]
        token = tokens[0] if tokens else "r-" + secrets.token_hex(12)
        for other in tokens[1:]:
            self.parent[other] = token
        for key in keys:
            self.raw[key] = token
        return token


def sanitize_result(item, pseudonym, release_id):
    out = {"releaseId": release_id, "indexer": pseudonym, "title": clean_text(item.get("title"))}
    out["protocol"] = item.get("protocol") if item.get("protocol") in ("torrent", "usenet", "unknown") else "unknown"
    for key in ("seeders", "leechers", "size", "grabs", "age"):
        val = item.get(key)
        out[key] = val if type(val) in (int, float) and math.isfinite(val) and val >= 0 else None
    for key in ("tmdbId", "tvdbId"):
        val = item.get(key)
        out[key] = val if type(val) is int and val > 0 else None
    categories = item.get("categories")
    out["categories"] = [x["id"] for x in categories if isinstance(x, dict) and type(x.get("id")) is int] if isinstance(categories, list) else []
    for key in ("magnetUrl", "downloadUrl"):
        out[key + "Present"] = isinstance(item.get(key), str) and bool(item[key].strip())
    return out


def validate_base(url):
    parsed = urllib.parse.urlsplit(url or "")
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SafeError("invalid_base_url")
    return url.rstrip("/")


def validate_override(url):
    base = validate_base(url)
    host = urllib.parse.urlsplit(base).hostname
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise SafeError("override_must_be_loopback")
    return base


def read_settings(path):
    uri = "file:" + urllib.parse.quote(os.path.abspath(path)) + "?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    try:
        db.execute("PRAGMA query_only=ON")
        row = db.execute("SELECT document_json FROM app_settings WHERE id=1").fetchone()
        data = json.loads(row[0]) if row else {}
        integration = data.get("integrations", {}).get("prowlarr", {})
        url, key = integration.get("url"), integration.get("apiKey")
        if not isinstance(key, str) or not key:
            raise SafeError("invalid_settings")
        return validate_base(url), key
    finally:
        db.close()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Transport:
    def __init__(self, base, key, deadline, opener=None, clock=time.monotonic):
        self.base, self.key, self.deadline = validate_base(base), key, deadline
        self.opener = opener or urllib.request.build_opener(_NoRedirect)
        self.clock = clock

    def get(self, path, params=()):
        if path not in ("api/v1/indexer", "api/v1/indexerstatus", "api/v1/search"):
            raise SafeError("path_denied")
        url = self.base + "/" + path
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        left = self.deadline - self.clock()
        if left <= 0:
            raise SafeError("deadline")
        req = urllib.request.Request(url, headers={"X-Api-Key": self.key}, method="GET")
        def timeout_handler(signum, frame):
            raise SafeError("request_timeout")
        old_handler = signal.signal(signal.SIGALRM, timeout_handler)
        signal.setitimer(signal.ITIMER_REAL, min(30, left))
        try:
            response = self.opener.open(req, timeout=min(30, left))
            try:
                data = response.read(8 * 1024 * 1024 + 1)
                if len(data) > 8 * 1024 * 1024:
                    raise SafeError("response_limit")
                if self.clock() >= self.deadline:
                    raise SafeError("deadline")
                return json.loads(data)
            finally:
                response.close()
        except SafeError:
            raise
        except urllib.error.HTTPError as e:
            raise SafeError("http_" + str(e.code)) from None
        except Exception:
            raise SafeError("transport_error") from None
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old_handler)


def cooling(statuses, chosen):
    if not isinstance(statuses, list) or any(not isinstance(s, dict) or type(s.get("indexerId")) is not int for s in statuses):
        raise SafeError("invalid_statuses")
    now = datetime.datetime.now(datetime.timezone.utc)
    for row in statuses:
        if row["indexerId"] not in chosen or not row.get("disabledTill"):
            continue
        try:
            until = datetime.datetime.fromisoformat(row["disabledTill"].replace("Z", "+00:00"))
            if until.tzinfo is None or until > now:
                return True
        except (ValueError, TypeError, AttributeError):
            return True
    return False


def choose_indexers(indexers, statuses, wanted=None):
    if not isinstance(indexers, list) or any(not isinstance(x, dict) or type(x.get("id")) is not int for x in indexers):
        raise SafeError("invalid_indexers")
    healthy = sorted(x["id"] for x in indexers if x.get("enable") is True and not cooling(statuses, [x["id"]]))
    if wanted is not None:
        if not 1 <= len(wanted) <= 2 or len(set(wanted)) != len(wanted) or any(x not in healthy for x in wanted):
            raise SafeError("invalid_indexer_selection")
        return wanted
    if not healthy:
        raise SafeError("no_healthy_indexers")
    return healthy[:2]


def capture_dataset(manifest, transport, chosen, clock=time.monotonic, sleep=time.sleep):
    validate_manifest(manifest)
    start = clock()
    output = {"version": 1, "manifest": manifest, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "indexers": ["indexer-" + str(i+1) for i in range(len(chosen))], "queries": [],
              "limits": {"searches": 72, "seconds": 1800, "rows": 10000, "rowsPerQuery": 200},
              "labelStatus": "unreviewed", "stopReason": "finished"}
    identities, rows, seen = IdentityMap(), 0, set()
    for case in manifest["cases"]:
        for q in case["queries"]:
            identity = (q["query"], tuple(sorted(q["categories"])))
            if identity in seen:
                continue
            seen.add(identity)
            record = {"case": case["id"], "family": q["family"], "query": q["query"], "categories": q["categories"],
                      "indexers": output["indexers"], "limit": 200, "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      "complete": False, "completeness": "upstream-completeness-unknown", "results": []}
            started = clock()
            try:
                if output["queries"]:
                    sleep(1)
                if clock() - start >= 1800:
                    raise SafeError("deadline")
                if cooling(transport.get("api/v1/indexerstatus"), chosen):
                    raise SafeError("cooldown")
                params = [("query", q["query"]), ("type", "search"), ("limit", 200)]
                params += [("categories", c) for c in q["categories"]]
                params += [("indexerIds", x) for x in chosen]
                results = transport.get("api/v1/search", params)
                if cooling(transport.get("api/v1/indexerstatus"), chosen):
                    raise SafeError("cooldown_after_search")
                if not isinstance(results, list) or any(not isinstance(x, dict) or x.get("indexerId") not in chosen for x in results):
                    raise SafeError("invalid_results")
                count = min(len(results), 200, 10000 - rows)
                record.update({"status": "ok", "receivedCount": len(results), "storedCount": count,
                               "truncated": count < len(results) or len(results) >= 200})
                for item in results[:count]:
                    ident = identities.identify(item["indexerId"], item.get("guid"), item.get("infoHash"))
                    record["results"].append(sanitize_result(item, "indexer-" + str(chosen.index(item["indexerId"]) + 1), ident))
                rows += count
                if rows >= 10000:
                    output["stopReason"] = "row_limit"
            except SafeError as e:
                record.update({"status": "unavailable", "errorCode": e.code})
                output["stopReason"] = e.code
            except KeyboardInterrupt:
                record.update({"status": "unavailable", "errorCode": "interrupted"})
                output["stopReason"] = "interrupted"
            record["elapsedMs"] = round((clock() - started) * 1000)
            output["queries"].append(record)
            if output["stopReason"] != "finished":
                break
        if output["stopReason"] != "finished":
            break
    for query in output["queries"]:
        for item in query["results"]:
            item["releaseId"] = identities.canonical(item["releaseId"])
    output["storedRows"] = rows
    output["elapsedMs"] = round((clock() - start) * 1000)
    return output


def write_output(path, output):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf8") as f:
        json.dump(output, f, allow_nan=False, indent=2)
        f.write("\n")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--settings-db", required=True)
    p.add_argument("--manifest", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--execute", action="store_true")
    p.add_argument("--indexer-ids")
    p.add_argument("--base-url", help="Explicit same-service loopback connection override; does not modify saved settings")
    a = p.parse_args(argv)
    try:
        with open(a.manifest, encoding="utf8") as f:
            manifest = json.load(f)
        plan = validate_manifest(manifest)
        if not a.execute:
            print(json.dumps({"plan": plan, "live": False}))
            return 0
        if os.path.exists(a.out):
            raise SafeError("output_exists")
        base, key = read_settings(a.settings_db)
        if a.base_url:
            base = validate_override(a.base_url)
        transport = Transport(base, key, time.monotonic() + 1800)
        wanted = [int(x) for x in a.indexer_ids.split(",")] if a.indexer_ids else None
        chosen = choose_indexers(transport.get("api/v1/indexer"), transport.get("api/v1/indexerstatus"), wanted)
        output = capture_dataset(manifest, transport, chosen)
        write_output(a.out, output)
        print(json.dumps({"queries": len(output["queries"]), "storedRows": output["storedRows"], "stopReason": output["stopReason"]}))
        return 0 if output["stopReason"] == "finished" else 2
    except SafeError as e:
        print("capture_error:" + e.code, file=sys.stderr)
    except Exception:
        print("capture_error:failed", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
