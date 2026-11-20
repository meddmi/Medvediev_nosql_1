// Run: mongosh "$MONGODB_URI" --file queries/part2_queries.js
//
// Requires the `spotify.tracks` collection created by scripts/02_transform.js

db = db.getSiblingDB("spotify");

const SAMPLE_SIZE = 10;

function section(title) {
  print("\n" + "=".repeat(70));
  print(title);
  print("=".repeat(70));
}


// ==========================================================================
// Task 1. Party tracks
// danceability > 0.7, energy > 0.7, duration 3-5 minutes (180000-300000 ms)
// ==========================================================================
section("Task 1. Party tracks");

const partyFilter = {
  "audio_features.danceability": { $gt: 0.7 },
  "audio_features.energy": { $gt: 0.7 },
  duration_ms: { $gte: 180000, $lte: 300000 }
};

print("Matching tracks: " + db.tracks.countDocuments(partyFilter));
print("First " + SAMPLE_SIZE + " by popularity:");
db.tracks
  .find(partyFilter, {
    _id: 0,
    track_name: 1,
    artists: 1,
    popularity: 1,
    duration_sec: 1,
    "audio_features.danceability": 1,
    "audio_features.energy": 1
  })
  .sort({ popularity: -1 })
  .limit(SAMPLE_SIZE)
  .forEach(doc => printjson(doc));


// ==========================================================================
// Task 2. Artists whose tracks are all popular
// At least 3 tracks AND minimum popularity >= 60. Top 20.
// Output: artist, track count, min and avg popularity (1 decimal).
// ==========================================================================
section("Task 2. Artists with consistently popular tracks (top 20)");

db.tracks.aggregate([
  {
    $match: {
      popularity: {
        $gte: 60
      }
    }
  },
  { $unwind: "$artists" },
  {
    $group: {
      _id: "$artists",
      track_count: { $sum: 1 },
      min_popularity: { $min: "$popularity" },
      avg_popularity: { $avg: "$popularity" }
    }
  },
  {
    $match: {
      track_count: { $gte: 3 }
    }
  },
  { $sort: { avg_popularity: -1, track_count: -1, _id: 1 } },
  { $limit: 20 },
  {
    $project: {
      _id: 0,
      artist: "$_id",
      track_count: 1,
      min_popularity: { $round: ["$min_popularity", 1] },
      avg_popularity: { $round: ["$avg_popularity", 1] }
    }
  }
]).forEach(doc => printjson(doc));


// ==========================================================================
// Task 3. Outlier tracks: tempo > genre mean + 2 * genre standard deviation
// Output per genre: genre, avg_tempo, outlier_threshold, outlier_tracks[]
// ==========================================================================
section("Task 3. Tracks with unusually high tempo for their genre");

db.tracks.aggregate([
  {
    $group: {
      _id: "$track_genre",
      avg_tempo: { $avg: "$audio_features.tempo" },
      std_tempo: { $stdDevPop: "$audio_features.tempo" },
      tracks: {
        $push: {
          _id: "$_id",
          track_name: "$track_name",
          popularity: "$popularity",
          artists: "$artists",
          audio_features: { tempo: "$audio_features.tempo" }
        }
      }
    }
  },
  {
    $addFields: {
      outlier_threshold: { $add: ["$avg_tempo", { $multiply: [2, "$std_tempo"] }] }
    }
  },
  {
    $project: {
      _id: 0,
      genre: "$_id",
      avg_tempo: 1,
      outlier_threshold: 1,
      outlier_tracks: {
        $filter: {
          input: "$tracks", 
          as: "track",         
          cond: {
            $gt: [ "$$track.audio_features.tempo", "$outlier_threshold" ]
          }
        }
      }
    }
  },
  { $sort: { genre: 1 } }
])
.forEach(doc => printjson(doc));


// ==========================================================================
// Task 4. Tracks for background listening while working
// loudness < -10, speechiness < 0.1, instrumentalness > 0.5, not explicit
// ==========================================================================
section("Task 4. Background work tracks");

const backgroundFilter = {
  "audio_features.loudness": { $lt: -10 },
  "audio_features.speechiness": { $lt: 0.1 },
  "audio_features.instrumentalness": { $gt: 0.5 },
  explicit: false
};

print("Matching tracks: " + db.tracks.countDocuments(backgroundFilter));
print("First " + SAMPLE_SIZE + " by popularity:");
db.tracks
  .find(backgroundFilter, {
    _id: 0,
    track_name: 1,
    artists: 1,
    track_genre: 1,
    popularity: 1,
    explicit: 1,
    "audio_features.loudness": 1,
    "audio_features.speechiness": 1,
    "audio_features.instrumentalness": 1
  })
  .sort({ popularity: -1 })
  .limit(SAMPLE_SIZE)
  .forEach(doc => printjson(doc));
