"""Offline projection of the existing issue-6 capture; never opens DBs or HTTP.

Annotations are proposals, not an independent ground-truth oracle. Freeze only
after targeted human review. Selection is deterministic and keeps relative order.
"""
import argparse
import json
import re
from pathlib import Path


def title(value):
    value = re.sub(r'https?://\S+|magnet:\S+', '', value, flags=re.I)
    value = re.sub(r'\[[a-f0-9]{8,64}\]|\b[a-f0-9]{32,64}\b', '', value, flags=re.I)
    return re.sub(r'\s+', ' ', value).strip()


def norm(value):
    return ' '.join(re.findall(r'\w+', value.lower()))


def propose(case, value):
    text = norm(value)
    names = [case['title'], case.get('aliasHypothesis')]
    compatible = any(norm(n) in text for n in names if n)
    # Public title synonym, not production identity logic.
    if case.get('id') == 'frieren':
        compatible = compatible or 'frieren' in text
    if case.get('id') == 'oppenheimer' and text.startswith('to end all war'):
        return dict(identity='wrong', coveredEpisodeNumbers=[], coverageBasis='unknown', selection='unacceptable', reason='Different work: To End All War Oppenheimer The Atomic Bomb is a documentary, not the supplied feature film.')
    result = dict(identity='compatible' if compatible else 'unresolved', coveredEpisodeNumbers=[], coverageBasis='unknown', selection='uncertain', reason='Proposed from title evidence only; unresolved identity or scope requires review.')
    if not compatible:
        # Obvious distractors remain explicit review evidence, not name-oracle credit.
        if re.search(r'lego.*batman|dark knight|mo 2022', text):
            result.update(identity='wrong', selection='unacceptable', reason='Different named work/year in title.')
        return result
    if case['kind'] == 'movie':
        years = re.findall(r'\b(?:19|20)\d{2}\b', value)
        if str(case['year']) in years:
            result.update(selection='acceptable', coverageBasis='explicit', reason='Title and supplied movie year agree; no file-content verification.')
        elif years:
            result.update(identity='wrong', selection='unacceptable', reason='Explicit movie year differs from supplied identity.')
        return result
    seasons = [int(s) for s in re.findall(r'\bS(\d{1,2})(?=\b|E|v\d)', value, re.I)]
    seasons += [int(s) for s in re.findall(r'\bSeason\s*0?(\d{1,2})\b', value, re.I)]
    seasons += [int(s) for s in re.findall(r'\b(\d{1,2})(?:nd|rd|st|th) Season\b', value, re.I)]
    if seasons and case['seasonNumber'] not in seasons:
        result.update(selection='unacceptable', reason='Explicit wrong season; no target coverage.')
        return result
    covered = []
    seasonal_ranges = [(int(s), int(lo), int(hi)) for s, lo, hi in re.findall(r'S(\d+)E(\d+)\s*[-~]\s*(?:E)?(\d+)', value, re.I)]
    absolute_ranges = [(int(lo), int(hi)) for lo, hi in re.findall(r'(?<!\d)(\d{2,4})\s*[-~]\s*(\d{2,4})(?!\d)', value)]
    for ep in case['episodes']:
        if any(s == case['seasonNumber'] and lo <= ep['episodeNumber'] <= hi for s, lo, hi in seasonal_ranges) or re.search(rf'S0?{case["seasonNumber"]}E0?{ep["episodeNumber"]}(?!\d)', value, re.I):
            covered.append(ep['episodeNumber'])
        elif case['kind'] == 'anime' and ep.get('absoluteEpisodeNumber') is not None and (any(lo <= ep['absoluteEpisodeNumber'] <= hi for lo, hi in absolute_ranges) or re.search(rf'(?:-\s*|\s|\[){ep["absoluteEpisodeNumber"]}(?!\d)', value)):
            covered.append(ep['episodeNumber'])
        elif case['kind'] == 'anime' and case['seasonNumber'] in seasons and re.search(rf'(?:Season\s*{case["seasonNumber"]}|S0?{case["seasonNumber"]}|{case["seasonNumber"]}(?:nd|rd|st|th) Season)\s*-\s*0?{ep["episodeNumber"]}(?!\d)', value, re.I):
            covered.append(ep['episodeNumber'])
    if covered:
        result.update(coveredEpisodeNumbers=covered, coverageBasis='explicit', selection='acceptable', reason='Explicit seasonal or verified absolute episode matches supplied target; title claim only.')
    elif case['seasonNumber'] in seasons and not re.search(r'E\d|(?:Season\s*\d+|S\d+)\s*-\s*\d+', value, re.I):
        result.update(coveredEpisodeNumbers=[e['episodeNumber'] for e in case['episodes']], coverageBasis='inferred', selection='uncertain', reason='Matching season-only pack inference; human review of acceptance needed, contents unverified.')
    elif re.search(r'S\d+E\d+| - \d+\b', value, re.I):
        result.update(selection='unacceptable', reason='Explicit episode not in supplied missing subset.')
    # Bracketed episode claims and multilingual numbering stay uncertain rather
    # than inventing a pack claim. These need the targeted human review report.
    if re.search(r'\[0?\d{1,4}\]', value):
        result.update(coverageBasis='unknown', coveredEpisodeNumbers=[], selection='uncertain', reason='Bracketed episode evidence needs human interpretation; not a season pack.')
    return result


def select(rows, limit=16):
    # Half first upstream rows, half highest seeder observations; no label-based
    # sampling. Keep distractors and original relative ordering, report omissions.
    first = rows[:limit // 2]
    highest = sorted(enumerate(rows), key=lambda p: (-(p[1].get('seeders') or 0), p[0]))[:limit - len(first)]
    ids = {r['releaseId'] for r in first} | {r['releaseId'] for _, r in highest}
    return [r for r in rows if r['releaseId'] in ids]


def project(raw):
    cases = []
    for c in raw['cases']:
        queries = [q for q in raw['queries'] if q['case'] == c['id']]
        chosen = {r['releaseId'] for q in queries for r in select(q['results'])}
        mapping, candidates = {}, []
        for q in queries:
            for r in q['results']:
                rid = r['releaseId']
                if rid not in chosen or rid in mapping:
                    continue
                cid = f'{c["id"]}-r{len(mapping)+1:03d}'
                mapping[rid] = cid
                label = propose(c, title(r['title']))
                if not (r['magnetUrlPresent'] or r['downloadUrlPresent']):
                    label.update(selection='unacceptable', reason='No downloadable presence evidence.')
                candidates.append(dict(id=cid, title=title(r['title']), downloadPresent=r['downloadUrlPresent'], magnetPresent=r['magnetUrlPresent'], size=r.get('size'), seeders=r.get('seeders'), leechers=r.get('leechers'), grabs=r.get('grabs'), age=r.get('age'), externalIds=[f'{kind}:{r[kind+"Id"]}' for kind in ['tvdb', 'tmdb'] if r.get(kind+'Id')], protocol=r['protocol'], categories=r['categories'], source=r['indexer'], review=label))
        episodes = [{k: e.get(k) for k in ['episodeNumber', 'absoluteEpisodeNumber', 'title']} for e in c.get('episodes', [])]
        cases.append(dict(id=c['id'], partition=c['partition'], input=dict(kind=c['kind'], title=c['title'], altTitles=[c['aliasHypothesis']] if c.get('aliasHypothesis') and c['aliasHypothesis'] != c['title'] else [], externalId=f'tmdb:{c["tmdbId"]}' if c['kind'] == 'movie' else f'tvdb:{c["tvdbId"]}', year=c.get('year'), seasonNumber=c.get('seasonNumber'), episodes=episodes), candidates=candidates, queries=[dict(query=q['query'], categories=q['categories'], indexers=q['indexers'], limit=q['limit'], candidateIds=[mapping[r['releaseId']] for r in q['results'] if r['releaseId'] in mapping], originalCount=len(q['results']), observedAt=q['observedAt'], availability='success', completeness='upstream-completeness-unknown') for q in queries], label=dict(identity='compatible', coveredEpisodeNumbers=[e['episodeNumber'] for e in episodes], coverageBasis='explicit', selection='uncertain', acceptableCandidateIds=[r['id'] for r in candidates if r['review']['selection'] == 'acceptable'], reason='Proposed labels. All acceptable options receive credit; uncertain candidates excluded from scored denominator. No exact winner or verified contents claim.')))
    return dict(schemaVersion=1, id='issue6-pilot-subset', revision=1, labelStatus='proposed', createdAt='2026-10-21T02:00:00.000Z', provenance=dict(sourcePurpose='Separate public anime and public general-purpose source snapshots; no private tracker or personal library.', observedAt='2026-10-21T01:50:20.000Z', completeness='upstream-completeness-unknown', notes='Derived from issue6-pilot-v1: 12 works, 38 exact queries, 2010 observations. First 8 plus highest-seeder 8 per query; union preserves within-case physical identity and original query order. Counts expose omitted rows. Adult-source evidence excluded; unavailable source not empty. Public TVDB/Skyhook and TMDB identities, supplied synthetic missing episodes. Title checksums removed, opaque IDs reassigned; original IDs/links absent. Not indexer-wide recall. Proposed 8/4 split exposed during annotation, not blind evaluation.'), cases=cases)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('capture', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('--reviewed', action='store_true', help='Only after explicit human rubric/identity/disclosure approval')
    a = p.parse_args()
    result = project(json.loads(a.capture.read_text()))
    if a.reviewed:
        result['labelStatus'] = 'reviewed'
        result['provenance']['notes'] += ' Assistant inspected all retained titles and corrected range/identity proposals. Human approved inferred-pack acceptance, named identity distractors, Blue Box mapping, and publication/provider disclosure. Targeted rubric review, not independent file verification; bracketed ambiguous claims remain uncertain.'
        for case in result['cases']:
            for candidate in case['candidates']:
                if candidate['review']['coverageBasis'] == 'inferred':
                    candidate['review'].update(selection='acceptable', reason='Human-approved matching-season pack rubric; inferred coverage only, contents not verified.')
            case['label']['acceptableCandidateIds'] = [r['id'] for r in case['candidates'] if r['review']['selection'] == 'acceptable']
            case['label']['reason'] = 'Human-approved multi-acceptable rubric; assistant annotations, targeted human identity/pack review. Uncertain candidates unscored. No contents or exhaustive recall claim.'
    a.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with a.output.open('x') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.write('\n')
