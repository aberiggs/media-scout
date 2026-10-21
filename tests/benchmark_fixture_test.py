import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('fixture', Path(__file__).parents[1] / 'tools/benchmark_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

class FixtureTests(unittest.TestCase):
    def test_sanitizes_nested_checksum_and_link_without_changing_release_scope(self):
        self.assertEqual(fixture.title('[Group] Show S02E01 [A693EAF6] https://private.invalid/x?key=secret'), '[Group] Show S02E01')

    def test_labels_wrong_season_and_multiple_acceptable_explicit_variants(self):
        case = {'kind': 'anime', 'title': 'Example', 'aliasHypothesis': 'Rei', 'seasonNumber': 2, 'episodes': [{'episodeNumber': 1, 'absoluteEpisodeNumber': 26}]}
        self.assertEqual(fixture.propose(case, 'Example S01E01')['selection'], 'unacceptable')
        for title in ['Example S02E01 1080p', 'Rei - 26 [720p]']:
            self.assertEqual(fixture.propose(case, title)['coveredEpisodeNumbers'], [1])
            self.assertEqual(fixture.propose(case, title)['selection'], 'acceptable')
        self.assertEqual(fixture.propose(case, 'Example S02 1080p')['coverageBasis'], 'inferred')

    def test_keeps_exact_query_order_and_records_subset_omissions(self):
        rows = [{'releaseId': str(i), 'title': f'Example S02E0{i+1}', 'seeders': i} for i in range(20)]
        selected = fixture.select(rows, 6)
        self.assertEqual([r['releaseId'] for r in selected], ['0', '1', '2', '17', '18', '19'])

if __name__ == '__main__': unittest.main()
