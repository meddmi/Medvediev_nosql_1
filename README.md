# Medvediev_nosql_1
## Part 1 — Schema design questions

### Why are the audio characteristics grouped into a nested `audio_features` object instead of being stored flat?

**Why nest them**

- They form one logical unit. `danceability`, `energy`, `loudness`, `speechiness`, `acousticness`, `instrumentalness`, `liveness`, `valence`, `tempo`, `key`, `mode` and `time_signature` are all produced by the same audio analysis. They describe *how the track sounds*, whereas `track_name`, `album_name`, `artists`, `popularity` and `explicit` describe *what the track is*.
- No name ambiguity. Generic names such as `key`, `mode` and `energy` could be mistaken for metadata or collide with future top-level fields. `audio_features.key` is unambiguous.
- The group is easy to read or skip as a whole. Feeding the features to an ML or recommendation job takes one field.
- It is easy to extend. New analysis metrics can be added inside the object without touching the track-level schema.

**When nesting pays off**

- The fields are usually read, written or exported together.
- The group has a clear semantic boundary and is likely to grow.
- Field names are generic enough that a prefix or namespace is helpful.
- Documents are served to an API or UI where the JSON shape matters.

**When nesting causes problems**

- Longer paths everywhere. Every query, index, projection and `$group` must use `audio_features.energy`, which is easy to get wrong.
- Partial updates need care.
- Tooling friction. CSV export, BI tools (Tableau, Power BI) and many dataframe libraries expect flat columns. Nested objects need flattening first (`json_normalize`, `$project`).
- Mixed access patterns. If most queries touch one or two features and rarely the rest, nesting gives no benefit, and in that case the group is just extra path.
- Deep nesting compounds all of the above. Here only one level is used, which keeps the cost low. Going three or four levels deep would make paths and updates painful.

### Why are artists stored as an array instead of a string?

The raw CSV has a single string such as `"Drake; Future"`. After `$split` and `$trim` it becomes `["Drake", "Future"]`. A string hides the structure that MongoDB can query natively.

Queries that become simpler or possible:
 * Tracks by an artist
 * Tracks by any of several artists
 * Collaborations between two specific artists
 * Number of artists on a track (solo vs collab)
 * Primary (first-listed) artist
 * Per-artist statistics (average popularity, track count, top artists)
 * Distinct artists
 * Adding or removing an artist

**Indexing.** A single index on `artists` becomes a multikey index with one entry per element, so `{ artists: "Drake" }` is an index lookup. A regex search over strings would scan the whole collection.

## Part 3

### Task 1 — Query analysis and indexing
Query under analysis:

```js
db.tracks.find({
  track_genre: "pop",
  "audio_features.danceability": { $gte: 0.7 }
}).sort({ popularity: -1 })
```

Index created (in `queries/part3_indexes.js`):

```js
db.tracks.createIndex(
  { track_genre: 1, popularity: -1, "audio_features.danceability": 1 },
  { name: "genre_popularity_danceability" }
)
```

The scripts are in `queries/part3_indexes.js`. The numbers below come from `explain("executionStats")` on the real `spotify.tracks` collection (113,999 documents, MongoDB 8.0.39).

### What changed in the execution plan?

![Task 1 index analysis: explain output before](screenshots/3.1%20index%20analysis%20before.png)
![Task 1 index analysis: explain output after](screenshots/3.1%20index%20analysis%20after.png)

- **Before.** MongoDB had no useful index, so it read every document in the collection (`COLLSCAN`), applied both filters to each one, and then sorted the 354 matches by `popularity` in memory (`SORT`).
- **After.** MongoDB walks the new index (`IXSCAN`) and fetches only the documents that match (`FETCH`).
  - `track_genre` is an equality, so the scan is restricted to the `"pop"` part of the index.
  - Within that part the entries are already ordered by `popularity` descending, which is the requested order. The `SORT` stage disappeared because the index provides the order.
  - The `danceability >= 0.7` range is checked on the index entries, so non-matching tracks are not fetched from disk. 412 keys were examined, 354 documents were fetched, and each fetched document was a result.
- **Result.** The same 354 documents are returned, but 322x fewer documents are read and the query is about 60x faster in this run (72 ms -> 2 ms). On a bigger collection the gap would grow, because the collection scan grows with total size while the index scan grows only with the number of `"pop"` entries.

### How can we tell that the index is actually used?

1. **`queryPlanner.winningPlan`: the stage names.**
   - Index used: the plan contains `IXSCAN`.
   - Index not used: the plan contains `COLLSCAN`.
2. **`IXSCAN.indexName`.** After creating the index it is `"genre_popularity_danceability"`.
3. **`IXSCAN.indexBounds`.** It shows how the index is narrowed:
   ```
   track_genre:                  [ "pop", "pop" ]      // exact equality
   popularity:                   [ MaxKey, MinKey ]    // whole range, scanned in sort order
   audio_features.danceability:  [ 0.7, inf.0 ]        // range from the query
   ```
4. **No `SORT` stage** in `winningPlan`. The order comes from the index (`direction: "forward"` on an index built with `popularity: -1`).
5. **`executionStats` counters.**
   - `totalKeysExamined` goes from 0 to 412, which means the index was read.
   - `totalDocsExamined` drops from 113,999 to 354, and is now equal to `nReturned`. This is the ideal ratio.
   - `executionTimeMillis` drops from 72 to 2.
6. **`rejectedPlans`** was empty in both runs. When it is not empty, it lists the other candidate plans that the optimizer considered and discarded.

Another way to verify the index is used is `db.tracks.aggregate([{ $indexStats: {} }])`. The `accesses.ops` counter of `genre_popularity_danceability` grows every time a query uses it.

### Task 2 — Index for "music for work" searches

Query:

```js
db.tracks.find({
  explicit: false,
  "audio_features.instrumentalness": { $gt: 0.5 },
  "audio_features.speechiness": { $lt: 0.1 }
})
```

Index (in `queries/part3_indexes.js`):

```js
db.tracks.createIndex(
  { explicit: 1, "audio_features.instrumentalness": 1, "audio_features.speechiness": 1 },
  { name: "explicit_instrumentalness_speechiness" }
)
```

**`explain("executionStats")` before and after**:

![Task 2 index analysis: explain output before](screenshots/3.2%20index%20analysis%20before.png)
![Task 2 index analysis: explain output after](screenshots/3.2%20index%20analysis%20after.png)

**How the output proves the index is used:**

- `winningPlan` contains `IXSCAN` with `indexName: "explicit_instrumentalness_speechiness"` instead of `COLLSCAN`.
- `indexBounds` shows all three conditions applied inside the index:
  ```
  explicit:                         [ false, false ]
  audio_features.instrumentalness:  ( 0.5, inf.0 ]
  audio_features.speechiness:       [ -inf.0, 0.1 )
  ```
- `totalDocsExamined` equals `nReturned` (16,141), so every fetched document is a result. Without the index, 113,999 documents were read to return the same 16,141.
- `rejectedPlans` is empty, so the optimizer had no competing plan.

### Task 3 — Is this a covered query?

Query (the Task 1 index `{ track_genre: 1, popularity: -1, "audio_features.danceability": 1 }` exists):

```js
db.tracks.find({
  track_genre: "pop",
  popularity: { $gte: 70 }
});
```

**Answer: No, as written, this query is not covered.**

A query is covered when MongoDB can answer it using only the index, without reading any document from the collection. Two conditions must both hold:

1. **Every field used in the filter (and sort) is in the index.**
2. **Every field in the result is in the index.** 

**Condition 1 is met.** The filter uses `track_genre` and `popularity`. Both are keys of the Task 1 index, and the leading key `track_genre` is used with an equality, so the index is usable. The index is also usable even though the third key `danceability` is not part of the filter.

**Condition 2 is not met.** The query has no projection, so it returns **entire documents**. The index contains only `track_genre`, `popularity` and `audio_features.danceability` (plus a pointer to the document). MongoDB has to add a `FETCH` stage and read every matching document from the collection.

So the index makes the search fast, because it finds the 317 matching entries without scanning 113,999 documents, but it does not cover the query.

**Covered query in `explain()`:** `totalDocsExamined: 0`, no `FETCH` stage, and `PROJECTION_COVERED` (or an `IXSCAN` directly under the projection stage) in `winningPlan`.

![Task 3 covered query analysis](screenshots/3.3%20covered%20query%20analysis.png)