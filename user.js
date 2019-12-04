"use strict";

const request = require("request");
const config = require("./config");
const pg = require("pg");

pg.defaults.ssl = true;

module.exports = {
  addUser: function(callback, userId) {
    request(
      {
        uri: "https://graph.facebook.com/v3.2/" + userId,
        qs: {
          access_token: config.FB_PAGE_TOKEN
        }
      },
      function(error, response, body) {
        if (!error && res.statusCode == 200) {
          var user = JSON.parse(body);
          console.log("getUserData: " + user);
          if (user.first_name) {
            var pool = new pg.Pool(config.PG_CONFIG);
            pool.connect(function(err, client, done) {
              if (err) {
                return console.error("Error acquiring client", err.stack);
              }
              var rows = [];
              client.query(
                `SELECT fb_id FROM users WHERE fb_id='${senderID} LIMIT 1`,
                function(err, result) {
                  if (err) {
                    return console.error("Query error" + err);
                  } else {
                    if (result.rows.length === 0) {
                      let sql =
                        "INSERT INTO users (fb_id, first_name, last_name, profile_pic) VALUES ($1, $2, $3, $4)";
                      client.query(sql, [
                        senderID,
                        user.first_name,
                        user.last_name,
                        user.profile_pic
                      ]);
                    }
                  }
                }
              );
              callback(user);
            });
            pool.end();
          } else {
            console.log("Cannot get data for fb user with id,", senderID);
          }
        } else {
          console.error(res.error);
        }
      }
    );
  }
};
