// Run: mongosh "$MONGODB_URI" --file queries/part3_indexes.js
//
// Requires the `spotify.tracks` collection created by scripts/02_transform.js.

db = db.getSiblingDB("spotify");

const INDEX_NAME = "genre_popularity_danceability";

function buildQuery() {
  return db.tracks
    .find({
      track_genre: "pop",
      "audio_features.danceability": { $gte: 0.7 }
    })
    .sort({ popularity: -1 });
}

function collectStages(plan, acc = []) {
  if (!plan) return acc;
  acc.push(plan.stage + (plan.indexName ? " (" + plan.indexName + ")" : ""));
  if (plan.inputStage) collectStages(plan.inputStage, acc);
  if (plan.inputStages) plan.inputStages.forEach(s => collectStages(s, acc));
  return acc;
}

function summarize(label, explain) {
  const stats = explain.executionStats;
  const winning = explain.queryPlanner.winningPlan;
  const plan = winning.queryPlan || winning;
  const stages = collectStages(plan);

  print("\n--- " + label + " ---");
  print("Winning plan stages : " + stages.join(" <- "));
  print("In-memory SORT stage: " + stages.some(s => s.startsWith("SORT")));
  print("nReturned           : " + stats.nReturned);
  print("totalKeysExamined   : " + stats.totalKeysExamined);
  print("totalDocsExamined   : " + stats.totalDocsExamined);
  print("executionTimeMillis : " + stats.executionTimeMillis);
  print("raw plan JSON       : " + JSON.stringify(winning, null, 2));
}


// --------------------------------------------------------------------------
// Step 0. Clean state, so the script can be re-run (idempotent)
// --------------------------------------------------------------------------
if (db.tracks.getIndexes().some(i => i.name === INDEX_NAME)) {
  db.tracks.dropIndex(INDEX_NAME);
  print("Dropped existing index " + INDEX_NAME);
}

print("Documents in tracks: " + db.tracks.countDocuments());
print("Indexes before      : " + db.tracks.getIndexes().map(i => i.name).join(", "));


// --------------------------------------------------------------------------
// Step 1. explain() WITHOUT a supporting index
// --------------------------------------------------------------------------
const explainBefore = buildQuery().explain("executionStats");
summarize("BEFORE index", explainBefore);


// --------------------------------------------------------------------------
// Step 2. Create the index
// --------------------------------------------------------------------------
db.tracks.createIndex(
  { track_genre: 1, popularity: -1, "audio_features.danceability": 1 },
  { name: INDEX_NAME }
);
print("\nCreated index " + INDEX_NAME);


// --------------------------------------------------------------------------
// Step 3. explain() AFTER creating the index
// --------------------------------------------------------------------------
const explainAfter = buildQuery().explain("executionStats");
summarize("AFTER index", explainAfter);


// --------------------------------------------------------------------------
// Comparison
// --------------------------------------------------------------------------
const b = explainBefore.executionStats;
const a = explainAfter.executionStats;
print("\n=== Comparison (before -> after) ===");
print("totalDocsExamined   : " + b.totalDocsExamined + " -> " + a.totalDocsExamined);
print("totalKeysExamined   : " + b.totalKeysExamined + " -> " + a.totalKeysExamined);
print("executionTimeMillis : " + b.executionTimeMillis + " -> " + a.executionTimeMillis);


// ==========================================================================
// Task 2. Index for "music for work" searches
//
// Query: not explicit, instrumentalness > 0.5, speechiness < 0.1
// ==========================================================================
print("\n\n" + "=".repeat(70));
print("Task 2. Index for background / work music search");
print("=".repeat(70));

const WORK_INDEX_NAME = "explicit_instrumentalness_speechiness";

function buildWorkQuery() {
  return db.tracks.find({
    explicit: false,
    "audio_features.instrumentalness": { $gt: 0.5 },
    "audio_features.speechiness": { $lt: 0.1 }
  });
}

if (db.tracks.getIndexes().some(i => i.name === WORK_INDEX_NAME)) {
  db.tracks.dropIndex(WORK_INDEX_NAME);
  print("Dropped existing index " + WORK_INDEX_NAME);
}

const workBefore = buildWorkQuery().explain("executionStats");
summarize("BEFORE index (work music)", workBefore);

db.tracks.createIndex(
  { explicit: 1, "audio_features.instrumentalness": 1, "audio_features.speechiness": 1 },
  { name: WORK_INDEX_NAME }
);
print("\nCreated index " + WORK_INDEX_NAME);

const workAfter = buildWorkQuery().explain("executionStats");
summarize("AFTER index (work music)", workAfter);

const wb = workBefore.executionStats;
const wa = workAfter.executionStats;
print("\n=== Comparison (before -> after) ===");
print("totalDocsExamined   : " + wb.totalDocsExamined + " -> " + wa.totalDocsExamined);
print("totalKeysExamined   : " + wb.totalKeysExamined + " -> " + wa.totalKeysExamined);
print("executionTimeMillis : " + wb.executionTimeMillis + " -> " + wa.executionTimeMillis);

const workPlan = workAfter.queryPlanner.winningPlan.queryPlan || workAfter.queryPlanner.winningPlan;
print("Index used: " + collectStages(workPlan).some(s => s.includes(WORK_INDEX_NAME)));


// ==========================================================================
// Task 3. Is this a covered query?
//
// db.tracks.find({ track_genre: "pop", popularity: { $gte: 70 } })
//
// Assumes the Task 1 index exists (it is created above).
// ==========================================================================
print("\n\n" + "=".repeat(70));
print("Task 3. Covered query check");
print("=".repeat(70));

const coverFilter = { track_genre: "pop", popularity: { $gte: 70 } };

function explainFind(projection) {
  const cursor = projection
    ? db.tracks.find(coverFilter, projection)
    : db.tracks.find(coverFilter);
  return cursor.explain("executionStats");
}

function checkCovered(label, projection) {
  const e = explainFind(projection);
  const winning = e.queryPlanner.winningPlan;
  const stages = collectStages(winning.queryPlan || winning);
  const covered =
    e.executionStats.totalDocsExamined === 0 && !stages.some(s => s.startsWith("FETCH"));
  print("\n--- " + label + " ---");
  print("Stages            : " + stages.join(" <- "));
  print("totalKeysExamined : " + e.executionStats.totalKeysExamined);
  print("totalDocsExamined : " + e.executionStats.totalDocsExamined);
  print("nReturned         : " + e.executionStats.nReturned);
  print("COVERED           : " + covered);
}

checkCovered("1. As given (no projection)", null);
checkCovered("2. Projection { _id: 0, track_genre: 1, popularity: 1 }",
  { _id: 0, track_genre: 1, popularity: 1 });
checkCovered("3. Projection { track_genre: 1, popularity: 1 } (_id returned)",
  { track_genre: 1, popularity: 1 });
checkCovered("4. Projection { _id: 0, track_name: 1, popularity: 1 }",
  { _id: 0, track_name: 1, popularity: 1 });
checkCovered("5. Projection { _id: 0, track_genre: 1, popularity: 1, audio_features.danceability: 1 }",
  { _id: 0, track_genre: 1, popularity: 1, "audio_features.danceability": 1 });
