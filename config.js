// Supabase connection for the Rhinebeck sidewalk survey map.
// The publishable (anon) key is designed to be public: it goes in
// client-side code by design. It can only do what the database's
// row-level-security policies allow (read parcels, read/insert/update
// assessments). Never put the service_role key here.
//
// How to fill this in: Supabase Dashboard -> Project Settings -> API,
// copy the "publishable" key and replace the placeholder below.
window.SURVEY_CONFIG = {
  SUPABASE_URL: "https://cgwnnzjkidlreezvsita.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_6Wsa72ZYlqTk8C5Wbbw9yA_t9kZZe7y"
};
