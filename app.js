"use strict";

const dialogflow = require("dialogflow");
const config = require("./config");
const express = require("express");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const request = require("request");
const pg = require("pg");
const app = express();
const uuid = require("uuid");
const userService = require("./user");
const colors = require('./colors');

pg.defaults.ssl = true;

// Messenger API parameters
if (!config.FB_PAGE_TOKEN) {
  throw new Error("missing FB_PAGE_TOKEN");
}
if (!config.FB_VERIFY_TOKEN) {
  throw new Error("missing FB_VERIFY_TOKEN");
}
if (!config.GOOGLE_PROJECT_ID) {
  throw new Error("missing GOOGLE_PROJECT_ID");
}
if (!config.DF_LANGUAGE_CODE) {
  throw new Error("missing DF_LANGUAGE_CODE");
}
if (!config.GOOGLE_CLIENT_EMAIL) {
  throw new Error("missing GOOGLE_CLIENT_EMAIL");
}
if (!config.GOOGLE_PRIVATE_KEY) {
  throw new Error("missing GOOGLE_PRIVATE_KEY");
}
if (!config.FB_APP_SECRET) {
  throw new Error("missing FB_APP_SECRET");
}
if (!config.SERVER_URL) {
  //used for ink to static files
  throw new Error("missing SERVER_URL");
}

app.set("port", process.env.PORT || 5000);

//verify request came from facebook
app.use(
  bodyParser.json({
    verify: verifyRequestSignature
  })
);

//serve static files in the public directory
app.use(express.static("public"));

// Process application/x-www-form-urlencoded
app.use(
  bodyParser.urlencoded({
    extended: false
  })
);

// Process application/json
app.use(bodyParser.json());

const credentials = {
  client_email: config.GOOGLE_CLIENT_EMAIL,
  private_key: config.GOOGLE_PRIVATE_KEY
};

const sessionClient = new dialogflow.SessionsClient({
  projectId: config.GOOGLE_PROJECT_ID,
  credentials
});

const sessionIds = new Map();
const usersMap = new Map();

// Index route
app.get("/", function(req, res) {
  res.send("Hello world, I am a chat bot");
});

// for Facebook verification
app.get("/webhook/", function(req, res) {
  console.log("request");
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === config.FB_VERIFY_TOKEN
  ) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post("/webhook/", function(req, res) {
  var data = req.body;
  console.log(JSON.stringify(data));

  // Make sure this is a page subscription
  if (data.object == "page") {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log(
            "Webhook received unknown messagingEvent: ",
            messagingEvent
          );
        }
      });
    });

    // Assume all went well.
    // You must send back a 200, within 20 seconds
    res.sendStatus(200);
  }
});

function setSessionAndUser(senderID) {
  if (!sessionIds.has(senderID)) {
    sessionIds.set(senderID, uuid.v1());
  }

  if (!usersMap.has(senderID)) {
    userService.addUser(function(user) {
      usersMap.set(senderID, user);
    }, senderID);
  }
}

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  setSessionAndUser(senderID);
  //console.log("Received message for user %d and page %d at %d with message:", senderID, recipientID, timeOfMessage);
  //console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    handleEcho(messageId, appId, metadata);
    return;
  } else if (quickReply) {
    handleQuickReply(senderID, quickReply, messageId);
    return;
  }

  if (messageText) {
    //send message to api.ai
    sendToDialogFlow(senderID, messageText);
  } else if (messageAttachments) {
    handleMessageAttachments(messageAttachments, senderID);
  }
}

function handleMessageAttachments(messageAttachments, senderID) {
  //for now just reply
  sendTextMessage(senderID, "Attachment received. Thank you.");
}

function handleQuickReply(senderID, quickReply, messageId) {
  var quickReplyPayload = quickReply.payload;
  console.log(
    "Quick reply for message %s with payload %s",
    messageId,
    quickReplyPayload
  );
  //send payload to api.ai
  sendToDialogFlow(senderID, quickReplyPayload);
}

//https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-echo
function handleEcho(messageId, appId, metadata) {
  // Just logging message echoes to console
  console.log(
    "Received echo for message %s and app %d with metadata %s",
    messageId,
    appId,
    metadata
  );
}

function handleDialogFlowAction(
  sender,
  action,
  messages,
  contexts,
  parameters
) {
  switch (action) {
    case 'iphone_colors':
      colors.readAllColors(function (allColors) {
        let allColorsString = allColors.join(', ');
        let reply = `IPhone XXX is available in ${allColorsString}, Which is your favourite?`;
        sendTextMessage(sender, reply);
      })
      break;

    case "iphone_colors.favourite":
      colors.updateUserColor(parameters.fields['color'].stringValue, sender);
      let reply = 'Oh, I like it too. I will remember that.'
      sendTextMessage(sender, reply);
      break;
    
    case 'buy.iphone':
      colors.readUserColor(function(color) {
        let reply;
        if (color === ''){
          reply = 'In what color would you like to have it ?'
        } else {
          reply = `Would you like it in your favourite color ${color} ?`
        }
        
      })
      sendTextMessage(sender, reply);
      break;
    case "get-current-weather":
      if (
        parameters.fields.hasOwnProperty("geo-city") &&
        parameters.fields["geo-city"] !== ""
      ) {
        request(
          {
            url: "http://api.openweathermap.org/data/2.5/weather",
            qs: {
              app_id: config.WEATHER_API_KEY,
              q: parameters.fields["geo-city"].stringValue
            }
          },
          function(err, res, body) {
            if (res.statusCode === 200) {
              let weather = JSON.parse(body);
              if (weather.hasOwnProperty("weather")) {
                let reply = `${messages[0].text.text} ${weather[weather][0]["description"]}`;
                sendTextMessage(sender, reply);
              } else {
                sendTextMessage(
                  sender,
                  "No weather forecast available for " +
                    parameters.fields["geo-city"].stringValue
                );
              }
            } else {
              sendTextMessage(sender, "Weather forecast is not available.");
            }
          }
        );
      } else {
        handleMessages(messages, sender);
      }

      break;
    case "faq-delivery":
      handleMessages(messages, sender);
      sendTypingOn(sender);
      setTimeout(() => {
        let buttons = [
          {
            type: "web_url",
            url: "https://www.myapple.com/track_order",
            title: "Track my order"
          },
          {
            type: "phone_number",
            title: "Call us",
            payload: "+918988989898"
          },
          {
            type: "postback",
            title: "Keep Chatting",
            payload: "CHAT"
          }
        ];
        sendButtonMessage(sender, "What would you like to do next ?", buttons);
      }, 3000);

      break;
    case "detailed_application":
      if (
        isDefined(contexts[0]) &&
        (contexts[0].name.includes("job_application") ||
          contexts[0].name.includes("job-application-details_dialog")) &&
        contexts[0].parameters
      ) {
        let phone_number =
          isDefined(contexts[0].parameters.fields["phone-number"]) &&
          contexts[0].parameters.fields["phone-number"] !== ""
            ? contexts[0].parameters.fields["phone-number"]
            : "";

        let user_name =
          isDefined(contexts[0].parameters.fields["user-name"]) &&
          contexts[0].parameters.fields["user-name"] !== ""
            ? contexts[0].parameters.fields["user-name"]
            : "";

        let previous_job =
          isDefined(contexts[0].parameters.fields["previous-job"]) &&
          contexts[0].parameters.fields["previous-job"] !== ""
            ? contexts[0].parameters.fields["previous-job"]
            : "";

        let years_of_experience =
          isDefined(contexts[0].parameters.fields["years-of-experience"]) &&
          contexts[0].parameters.fields["years-of-experience"] !== ""
            ? contexts[0].parameters.fields["years-of-experience"]
            : "";

        let job_vacancy =
          isDefined(contexts[0].parameters.fields["job-vacancy"]) &&
          contexts[0].parameters.fields["job-vacancy"] !== ""
            ? contexts[0].parameters.fields["job-vacancy"]
            : "";

        if (
          phone_number != "" &&
          user_name != "" &&
          previous_job != "" &&
          years_of_experience != ""
        ) {
          let replies = [
            {
              content_type: "text",
              title: "Less than a year",
              payload: "Less than a year."
            },
            {
              content_type: "text",
              title: "Less than 10 years",
              payload: "Less than 10 years."
            },
            {
              content_type: "text",
              title: "More than 10 years",
              payload: "More than 10 year."
            }
          ];

          sendQuickReply(sender, messages[0].text.text[0], replies);
        } else if (
          phone_number != "" &&
          user_name != "" &&
          previous_job != "" &&
          years_of_experience != "" &&
          job_vacancy != ""
        ) {
          let emailContent = `A new job enquiry from ${user_name} for the job: ${job_vacancy}
                        .<br /> Previous job position : ${previous_job}
                        .<br /> Years of experience : ${years_of_experience}
                        .<br /> Phone Number: ${phone_number}`;

          //   sendEmail("New job application", emailContent);

          handleMessages(message, sender);
        } else {
          handleMessages(messages, sender);
        }
      }
      break;
    default:
      //unhandled action, just send back the text
      handleMessages(messages, sender);
  }
}

function sendEmail(subject, content) {
  console.log("Sending email");
  var helper = require("sendgrid").mail;

  var from_email = new helper.Email(config.EMAIL_FROM);
  var to_email = new helper.Email(config.to_email);
  var subject = subject;
  var content = new helper.Content("text/html", content);
  var mail = new helper.Mail(from_email, subject, to_email, content);

  var sg = require("sendgrid")(config.SENDGRID_API_KEY);
  var request = sg.emptyRequest({
    method: "POST",
    path: "/v3/mail/send",
    body: mail.toJSON()
  });

  sg.API(request, function(err, res) {
    console.log(res.statusCode);
    console.log(res.body);
    console.log(res.headers);
  });
}

function handleMessage(message, sender) {
  switch (message.message) {
    case "text": //text
      message.text.text.forEach(text => {
        if (text !== "") {
          sendTextMessage(sender, text);
        }
      });
      break;
    case "quickReplies": //quick replies
      let replies = [];
      message.quickReplies.quickReplies.forEach(text => {
        let reply = {
          content_type: "text",
          title: text,
          payload: text
        };
        replies.push(reply);
      });
      sendQuickReply(sender, message.quickReplies.title, replies);
      break;
    case "image": //image
      sendImageMessage(sender, message.image.imageUri);
      break;
  }
}

function handleCardMessages(messages, sender) {
  let elements = [];
  for (var m = 0; m < messages.length; m++) {
    let message = messages[m];
    let buttons = [];
    for (var b = 0; b < message.card.buttons.length; b++) {
      let isLink = message.card.buttons[b].postback.substring(0, 4) === "http";
      let button;
      if (isLink) {
        button = {
          type: "web_url",
          title: message.card.buttons[b].text,
          url: message.card.buttons[b].postback
        };
      } else {
        button = {
          type: "postback",
          title: message.card.buttons[b].text,
          payload: message.card.buttons[b].postback
        };
      }
      buttons.push(button);
    }

    let element = {
      title: message.card.title,
      image_url: message.card.imageUri,
      subtitle: message.card.subtitle,
      buttons: buttons
    };
    elements.push(element);
  }
  sendGenericMessage(sender, elements);
}

function handleMessages(messages, sender) {
  let timeoutInterval = 1100;
  let previousType;
  let cardTypes = [];
  let timeout = 0;
  for (var i = 0; i < messages.length; i++) {
    if (
      previousType == "card" &&
      (messages[i].message != "card" || i == messages.length - 1)
    ) {
      timeout = (i - 1) * timeoutInterval;
      setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
      cardTypes = [];
      timeout = i * timeoutInterval;
      setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
    } else if (messages[i].message == "card" && i == messages.length - 1) {
      cardTypes.push(messages[i]);
      timeout = (i - 1) * timeoutInterval;
      setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
      cardTypes = [];
    } else if (messages[i].message == "card") {
      cardTypes.push(messages[i]);
    } else {
      timeout = i * timeoutInterval;
      setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
    }

    previousType = messages[i].message;
  }
}

function handleDialogFlowResponse(sender, response) {
  let responseText = response.fulfillmentMessages.fulfillmentText;

  let messages = response.fulfillmentMessages;
  let action = response.action;
  let contexts = response.outputContexts;
  let parameters = response.parameters;

  sendTypingOff(sender);

  if (isDefined(action)) {
    handleDialogFlowAction(sender, action, messages, contexts, parameters);
  } else if (isDefined(messages)) {
    handleMessages(messages, sender);
  } else if (responseText == "" && !isDefined(action)) {
    //dialogflow could not evaluate input.
    sendTextMessage(
      sender,
      "I'm not sure what you want. Can you be more specific?"
    );
  } else if (isDefined(responseText)) {
    sendTextMessage(sender, responseText);
  }
}

async function sendToDialogFlow(sender, textString, params) {
  sendTypingOn(sender);

  try {
    const sessionPath = sessionClient.sessionPath(
      config.GOOGLE_PROJECT_ID,
      sessionIds.get(sender)
    );

    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: textString,
          languageCode: config.DF_LANGUAGE_CODE
        }
      },
      queryParams: {
        payload: {
          data: params
        }
      }
    };
    const responses = await sessionClient.detectIntent(request);

    const result = responses[0].queryResult;
    handleDialogFlowResponse(sender, result);
  } catch (e) {
    console.log("error");
    console.log(e);
  }
}

function sendTextMessage(recipientId, text) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: text
    }
  };
  callSendAPI(messageData);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId, imageUrl) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: imageUrl
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: config.SERVER_URL + "/assets/instagram_logo.gif"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: config.SERVER_URL + "/assets/sample.mp3"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example videoName: "/assets/allofus480.mov"
 */
function sendVideoMessage(recipientId, videoName) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: config.SERVER_URL + videoName
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example fileName: fileName"/assets/test.txt"
 */
function sendFileMessage(recipientId, fileName) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: config.SERVER_URL + fileName
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId, text, buttons) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: text,
          buttons: buttons
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendGenericMessage(recipientId, elements) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: elements
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendReceiptMessage(
  recipientId,
  recipient_name,
  currency,
  payment_method,
  timestamp,
  elements,
  address,
  summary,
  adjustments
) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random() * 1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: recipient_name,
          order_number: receiptId,
          currency: currency,
          payment_method: payment_method,
          timestamp: timestamp,
          elements: elements,
          address: address,
          summary: summary,
          adjustments: adjustments
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId, text, replies, metadata) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: text,
      metadata: isDefined(metadata) ? metadata : "",
      quick_replies: replies
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons: [
            {
              type: "account_link",
              url: config.SERVER_URL + "/authorize"
            }
          ]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
  request(
    {
      uri: "https://graph.facebook.com/v3.2/me/messages",
      qs: {
        access_token: config.FB_PAGE_TOKEN
      },
      method: "POST",
      json: messageData
    },
    function(error, response, body) {
      if (!error && response.statusCode == 200) {
        var recipientId = body.recipient_id;
        var messageId = body.message_id;

        if (messageId) {
          console.log(
            "Successfully sent message with id %s to recipient %s",
            messageId,
            recipientId
          );
        } else {
          console.log(
            "Successfully called Send API for recipient %s",
            recipientId
          );
        }
      } else {
        console.error(
          "Failed calling Send API",
          response.statusCode,
          response.statusMessage,
          body.error
        );
      }
    }
  );
}

/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  setSessionAndUser(senderID);
  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  var payload = event.postback.payload;

  switch (payload) {
    case "GET_STARTED":
      greetUserText(senderID);
      break;
    case "CHAT":
      sendTextMessage(
        senderID,
        "I love chatting too. Do you have any other questions for me?"
      );
      break;
    case "JOB_APPLY":
      sendToDialogFlow(senderID, "job openings");
      break;
    default:
      //unindentified payload
      sendTextMessage(
        senderID,
        "I'm not sure what you want. Can you be more specific?"
      );
      break;
  }

  console.log(
    "Received postback for user %d and page %d with payload '%s' " + "at %d",
    senderID,
    recipientID,
    payload,
    timeOfPostback
  );
}

async function greetUserText(senderID) {
  let user = usersMap.get(senderID);

  if (!user) {
    await resolveAfterXSeconds(2);
    user = usersMap.get(senderID);
  }

  if(user) {
    sendTextMessage(
      userId,
      "Welcome " +
        user.first_name +
        "!" +
        "I can answer frequently asked questions for you and i perform JOb interviews. What can i help you with?"
    );
  } else {
    sendTextMessage(
      userId,
      "Welcome! I can answer frequently asked questions for you and i perform JOb interviews. What can i help you with?"
    );
  }
}

async function resolveAfterXSeconds(x){
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(x);
    }, x * 1000);
  })
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 *
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log(
    "Received message read event for watermark %d and sequence " + "number %d",
    watermark,
    sequenceNumber
  );
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 *
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log(
    "Received account link event with for user %d with status %s " +
      "and auth code %s ",
    senderID,
    status,
    authCode
  );
}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log(
        "Received delivery confirmation for message ID: %s",
        messageID
      );
    });
  }

  console.log("All message before %d were delivered.", watermark);
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger'
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log(
    "Received authentication for user %d and page %d with pass " +
      "through param '%s' at %d",
    senderID,
    recipientID,
    passThroughParam,
    timeOfAuth
  );

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    throw new Error("Couldn't validate the signature.");
  } else {
    var elements = signature.split("=");
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto
      .createHmac("sha1", config.FB_APP_SECRET)
      .update(buf)
      .digest("hex");

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

function isDefined(obj) {
  if (typeof obj == "undefined") {
    return false;
  }

  if (!obj) {
    return false;
  }

  return obj != null;
}

// Spin up the server
app.listen(app.get("port"), function() {
  console.log("running on port", app.get("port"));
});
