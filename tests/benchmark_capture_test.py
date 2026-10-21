import importlib.util
import pathlib
import json
import sqlite3
import signal
import tempfile
import urllib.error
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).parents[1] / "tools" / "benchmark_capture.py"
spec = importlib.util.spec_from_file_location("benchmark_capture", SCRIPT)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CaptureTests(unittest.TestCase):
    def test_pilot_manifest_has_balanced_cohorts_and_valid_bounded_queries(self):
        value=json.loads((SCRIPT.parent/'benchmark-manifests'/'pilot-v1.json').read_text())
        self.assertEqual(capture.validate_manifest(value),{'searches':52,'cases':12})
        self.assertEqual({kind:sum(c['kind']==kind for c in value['cases']) for kind in ['anime','tv','movie']}, {'anime':4,'tv':4,'movie':4})
    def test_base_override_validates_and_never_changes_settings(self):
        self.assertEqual(capture.validate_override("http://127.0.0.1:9696/"), "http://127.0.0.1:9696")
        with self.assertRaises(capture.SafeError): capture.validate_override("https://external.invalid")
        for value in ("https://user:secret@example.invalid", "https://example.invalid/?apikey=x", "file:///private/db", "https://example.invalid/#secret"):
            with self.assertRaises(capture.SafeError): capture.validate_base(value)

    def manifest(self, queries=2):
        return {"version": 1, "cases": [{"id": "a", "kind": "anime", "title": "Example", "queries": [
            {"family": "title", "query": "Example " + str(i), "categories": [5000, 5070]} for i in range(queries)
        ]}]}

    def test_enabled_indexers_without_status_are_healthy_and_cooling_are_excluded(self):
        rows = [{"id": 1, "enable": True}, {"id": 2, "enable": False}, {"id": 3, "enable": True}]
        self.assertEqual(capture.choose_indexers(rows, [{"indexerId": 3, "disabledTill": "2999-01-01T00:00:00Z"}]), [1])
        with self.assertRaises(capture.SafeError):
            capture.choose_indexers(rows, [], [1, 2])
        with self.assertRaises(capture.SafeError):
            capture.choose_indexers(rows, [], [1, 2, 3])

    def test_rejects_unsafe_or_malformed_manifest_not_silently_ignored(self):
        for field, value in [("categories", []), ("categories", [True]), ("query", "https://secret/?apikey=x"), ("family", "")]:
            m = self.manifest(1); m["cases"][0]["queries"][0][field] = value
            with self.assertRaises(capture.SafeError): capture.validate_manifest(m)
        m = self.manifest(1); m["secret"] = "not allowed"
        with self.assertRaises(capture.SafeError): capture.validate_manifest(m)

    def test_transitive_identity_bridges_rewrite_earlier_ids(self):
        ids = capture.IdentityMap()
        first = ids.identify(1, "a", "one")
        second = ids.identify(2, "b", "two")
        ids.identify(1, "a", "two")
        self.assertEqual(ids.canonical(first), ids.canonical(second))
        self.assertNotEqual(ids.identify(1, None, None), ids.identify(1, None, None))

    def test_allowlisted_values_and_embedded_secrets_are_sanitized(self):
        raw = {"title": "Title " + "a"*40 + " APIKEY: secret /private/secret/file", "protocol": "https://secret", "tmdbId": "secret", "tvdbId": 4,
               "downloadUrl": "https://secret", "magnetUrl": "magnet:?secret", "seeders": float('nan'), "grabs": 3}
        out = capture.sanitize_result(raw, "indexer-1", "r-1")
        self.assertNotIn("secret", json.dumps(out))
        self.assertNotIn("a"*40, out["title"])
        self.assertIsNone(out["seeders"])
        self.assertEqual(out["grabs"], 3)
        self.assertTrue(out["downloadUrlPresent"])
        self.assertTrue(out["magnetUrlPresent"])

    def test_read_settings_reads_only_existing_db_without_writing(self):
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d)/"settings.db"
            db = sqlite3.connect(p)
            db.execute("CREATE TABLE app_settings(id INTEGER,document_json TEXT)")
            db.execute("INSERT INTO app_settings VALUES(1,?)", (json.dumps({"integrations":{"prowlarr":{"url":"https://example.invalid/base","apiKey":"secret"}}}),))
            db.commit(); db.close()
            before = p.read_bytes()
            self.assertEqual(capture.read_settings(str(p)), ("https://example.invalid/base", "secret"))
            self.assertEqual(before, p.read_bytes())
            with self.assertRaises(Exception): capture.read_settings(str(p)+"missing")
            self.assertFalse(pathlib.Path(str(p)+"missing").exists())

    def test_transport_fixed_get_paths_headers_redirects_and_limits(self):
        class Response:
            def read(self, n): return b'[]'
            def close(self): pass
        class Opener:
            def open(self, req, timeout):
                self.req = req; self.timeout = timeout
                return Response()
        opener = Opener()
        t = capture.Transport("https://example.invalid/base", "secret", 100, opener=opener, clock=lambda: 90)
        self.assertEqual(t.get("api/v1/search", [("categories", 5000), ("categories", 5070)]), [])
        self.assertEqual(opener.req.get_method(), "GET")
        self.assertEqual(opener.req.get_header("X-api-key"), "secret")
        self.assertEqual(opener.timeout, 10)
        self.assertIn("/base/api/v1/search?categories=5000&categories=5070", opener.req.full_url)
        for path in ("api/v1/search/../download", "https://evil.invalid", "api/v3/series"):
            with self.assertRaises(capture.SafeError): t.get(path)
        self.assertIsNone(capture._NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid"))

    def run_capture(self, responses, manifest=None):
        class Fake:
            def __init__(self): self.calls = []
            def get(self, path, params=()):
                self.calls.append((path, params))
                if path.endswith("indexerstatus"): return []
                value = responses.pop(0)
                if isinstance(value, Exception): raise value
                return value
        transport = Fake(); sleeps = []
        out = capture.capture_dataset(manifest or self.manifest(), transport, [1], clock=lambda: 0, sleep=sleeps.append)
        return out, transport.calls, sleeps

    def test_empty_is_success_but_failure_stops_all_cases(self):
        m = self.manifest(2)
        m["cases"].append({"id":"b","kind":"movie","title":"Movie","queries":[{"family":"title","query":"Movie","categories":[2000]}]})
        out, calls, _ = self.run_capture([[], capture.SafeError("http_429")], m)
        self.assertEqual([q["status"] for q in out["queries"]], ["ok", "unavailable"])
        self.assertEqual(out["stopReason"], "http_429")
        self.assertEqual(len([c for c in calls if c[0].endswith("search")]), 2)
        self.assertFalse(out["queries"][0]["complete"])

    def test_exact_request_dedup_pacing_and_categories(self):
        m = self.manifest(2); m["cases"][0]["queries"].append(dict(m["cases"][0]["queries"][0]))
        out, calls, sleeps = self.run_capture([[], []], m)
        self.assertEqual(len(out["queries"]), 2)
        self.assertEqual(len(sleeps), 1)
        self.assertGreaterEqual(sleeps[0], 1)
        p = next(params for path, params in calls if path.endswith("search"))
        self.assertEqual([v for k,v in p if k == "categories"], [5000,5070])
        self.assertEqual([v for k,v in p if k == "indexerIds"], [1])

    def test_cooling_indexer_stops_before_search(self):
        class Fake:
            def get(self, path, params=()):
                self.assertion = path
                if path.endswith("indexerstatus"): return [{"indexerId":1,"disabledTill":"2999-01-01T00:00:00Z"}]
                raise AssertionError("search must not run")
        out = capture.capture_dataset(self.manifest(), Fake(), [1], clock=lambda: 0)
        self.assertEqual(out["stopReason"], "cooldown")

    def test_new_cooldown_after_http200_is_unavailable_not_empty(self):
        class Fake:
            statuses = 0
            def get(self, path, params=()):
                if path.endswith('indexerstatus'):
                    self.statuses += 1
                    return [] if self.statuses == 1 else [{"indexerId":1,"disabledTill":"2999-01-01T00:00:00Z"}]
                return []
        out = capture.capture_dataset(self.manifest(), Fake(), [1], clock=lambda: 0)
        self.assertEqual(out["stopReason"], "cooldown_after_search")
        self.assertEqual(out["queries"][0]["status"], "unavailable")
        self.assertEqual(len(out["queries"]), 1)

    def test_capture_stored_row_ceiling_and_per_query_truncation(self):
        m = self.manifest(6)
        for i in range(1,12):
            row = json.loads(json.dumps(m['cases'][0])); row['id'] = 'a-'+str(i)
            for q in row['queries']: q['query'] += ' '+str(i)
            m['cases'].append(row)
        out, calls, _ = self.run_capture([[{'indexerId':1,'title':'title'}]*210 for _ in range(72)], m)
        self.assertEqual(out['storedRows'],10000)
        self.assertEqual(out['stopReason'],'row_limit')
        self.assertEqual(len([x for x in calls if x[0].endswith('search')]),50)
        self.assertTrue(out['queries'][0]['truncated'])

    def test_transport_wall_deadline_interrupts_response_read(self):
        class Response:
            def read(self,n): signal.raise_signal(signal.SIGALRM)
            def close(self): pass
        class Opener:
            def open(self,*args,**kwargs): return Response()
        t=capture.Transport('http://127.0.0.1','secret',100,opener=Opener(),clock=lambda:90)
        def original_handler(*args): raise AssertionError('transport did not install wall deadline')
        old = signal.signal(signal.SIGALRM, original_handler)
        try:
            with self.assertRaises(capture.SafeError) as ctx: t.get('api/v1/search')
            self.assertEqual(ctx.exception.code,'request_timeout')
        finally: signal.signal(signal.SIGALRM,old)

    def test_response_limit_and_http_failure_have_safe_codes(self):
        class Response:
            def read(self,n): return b'x'*n
            def close(self): pass
        class Opener:
            def open(self,*args,**kwargs): return Response()
        t=capture.Transport('http://127.0.0.1','secret',100,opener=Opener(),clock=lambda:90)
        with self.assertRaises(capture.SafeError) as ctx: t.get('api/v1/search')
        self.assertEqual(ctx.exception.code,'response_limit')
        with patch.object(t.opener,'open',side_effect=urllib.error.HTTPError('https://secret',429,'secret',{},None)):
            with self.assertRaises(capture.SafeError) as ctx: t.get('api/v1/search')
            self.assertEqual(str(ctx.exception),'http_429')

    def test_immutable_private_output(self):
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d)/"out.json"
            capture.write_output(str(p), {"safe": True})
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): capture.write_output(str(p), {})
            self.assertEqual(json.loads(p.read_text()), {"safe": True})
    def test_plan_validates_case_and_counts_searches(self):
        manifest = {"version": 1, "cases": [{"id": "a", "kind": "anime", "title": "Example", "queries": [{"family": "title", "query": "Example", "categories": [5070]}]}]}
        self.assertEqual(capture.validate_manifest(manifest)["searches"], 1)
        with self.assertRaises(capture.SafeError):
            capture.validate_manifest({"version": 1, "cases": []})

    def test_dry_plan_never_opens_settings_or_network(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'manifest.json'; p.write_text(json.dumps(self.manifest(1)))
            with patch.object(capture,'read_settings',side_effect=AssertionError('must not read settings')):
                with patch('builtins.print'):
                    self.assertEqual(capture.main(['--manifest',str(p),'--settings-db','/missing','--out',str(p)+'.out']),0)
            self.assertFalse(pathlib.Path(str(p)+'.out').exists())

    def test_interruption_retains_prior_results_and_stops(self):
        class Fake:
            searches=0
            def get(self,path,params=()):
                if path.endswith('indexerstatus'): return []
                self.searches+=1
                if self.searches==2: raise KeyboardInterrupt()
                return [{'indexerId':1,'title':'Title'}]
        out=capture.capture_dataset(self.manifest(3),Fake(),[1],clock=lambda:0,sleep=lambda _:None)
        self.assertEqual(out['storedRows'],1)
        self.assertEqual(out['stopReason'],'interrupted')
        self.assertEqual(len(out['queries']),2)

    def test_sanitization_replaces_secrets_and_opaque_identity_unions_duplicates(self):
        ids = capture.IdentityMap()
        first = ids.identify(3, "guid-secret", "hash-secret")
        second = ids.identify(3, "guid-secret", "other-hash")
        self.assertEqual(first, second)
        clean = capture.sanitize_result({"title": "name https://x/?apikey=secret", "guid": "guid-secret", "magnetUrl": "magnet:?xt=urn:btih:hash-secret", "seeders": 5}, "idx-1", first)
        self.assertNotIn("secret", str(clean))
        self.assertNotIn("guid-secret", str(clean))


if __name__ == "__main__":
    unittest.main()
