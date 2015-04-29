Parse.Cloud.define("grantUserToAdmin", function(request, response) {  
  
  var query = new Parse.Query(Parse.Role); 
  query.equalTo("name", "admin"); 
  query.find({ 
    success: function(roles) {
      roles.forEach(function(role) {

        var q = new Parse.Query(Parse.User);
        q.equalTo("username", request.params.username);
        q.find({
          success: function(users) {
            // response.success(users);
            users.forEach(function(user) {
              Parse.Cloud.useMasterKey();
              role.getUsers().add(users);
              role.save();
              response.success(user);
            });
          }
        });
      });
    }
  });
});

// BACKGROUND JOBS
// ===============

Parse.Cloud.job("notifyHostsEventsWillStartSoon", function(request, status){
  var moment = require('moment');

  Parse.Config.get().then(function(config){

    var Event = Parse.Object.extend("Event");
    var Notification = Parse.Object.extend("Notification");
    var delayInHours = config.get("notificationTimeEventWillStartSoon") || 48;

    // find hosts to notify that their event will start in 48 hours.
    var query = new Parse.Query(Event);

    var hourRange = [
      new Date(moment.utc().startOf('hour').add('hours', delayInHours).toDate()),
      new Date(moment.utc().endOf('hour').add('hours', delayInHours).toDate())
    ];

    query.greaterThanOrEqualTo('startsAt', hourRange[0]);
    query.lessThanOrEqualTo('startsAt', hourRange[1]);
    query.notEqualTo('deleted', true);

    query.select("startsAt", "host", "name", "eventWillStartSoonReminderSent");
    // eventsStartingSoon.include("host");

    return query
    .find()
    .then(function(events){

      var promises = [];

      events.forEach(function(event){
        var notification = new Notification();

        if (!event.get("eventWillStartSoonReminderSent")) {
          promises.push(Parse.Promise.when([
            notification.save({
              user: event.get("host"),
              "event": event,
              notificationType: config.get("notificationTypes_eventWillStartSoon"),
              text: config.get("notificationMessages_eventWillStartSoon") || event.get("name") + " will start in the next " + delayInHours + " hours",
              read: false,
              sent: false
            }),

            event.save({
              "eventWillStartSoonReminderSent": new Date()
            })
          ]));
        }
      });

      return Parse.Promise
      .when(promises)
      .then(function(res){
        status.success(promises.length + " event hosts were successfully notified.");
      });
    });

  }, function(error){
    console.log("notifyHostsEventsWillStartSoon error");
    console.log(error);
    status.error(error);
  });
});

/**
 * Notify users to update their contribution and leave a review at the end of an event.
 * This job should be scheduled to run every 1 hour.
 */
Parse.Cloud.job("notifyUsersEventEnded", function(request, status){
  var moment = require('moment');
  var Notification = Parse.Object.extend("Notification");
  var SeatRequest = Parse.Object.extend("SeatRequest");
  var Event = Parse.Object.extend("Event");

  return Parse.Config
  .get()
  .then(function(config) {
    var query = new Parse.Query(Event);
    var delayInHoursAfterEventEnds = config.get("notificationTimePaymentReminderAfterEventEnded") || 0;

    var hourRange = [
      new Date(moment.utc().startOf('hour').add('hours', delayInHoursAfterEventEnds).toDate()),
      new Date(moment.utc().endOf('hour').add('hours', delayInHoursAfterEventEnds).toDate())
    ];

    query.greaterThanOrEqualTo('endDate', hourRange[0]);
    query.lessThanOrEqualTo('endDate', hourRange[1]);
    query.equalTo('status', 1);
    query.notEqualTo('deleted', true);
    query.doesNotExist('paymentRemindersSent');

    return query
    .find()
    .then(function(events){
      var counters = {
        events: 0,
        seatRequests: 0,
      };

      var done = events.map(function(event){
        var query = new Parse.Query(SeatRequest);
        query.equalTo('event', event);
        query.notEqualTo('deleted', true);
        query.doesNotExist('paymentReminderSent');

        return query
        .find()
        .then(function(seatRequests){
          seatRequests = seatRequests || [];

          var seats = seatRequests.map(function(seat){
            if (seat.get('paymentReminderSent')) return Parse.Promise.as();

            var notification = new Notification();

            var notified = notification.save({
              user: seat.get("user"),
              "event": seat.get("event"),
              seatRequest: seat,
              notificationType: config.get("notificationsTypes_paymentReminder"),
              text: config.get("notificationMessages_paymentReminder"),
              read: false,
              sent: false,
            });

            var updated = seat.save({
              "paymentReminderSent": new Date()
            });

            counters.seatRequests += 1;
            return Parse.Promise.when([notified, updated]);
          });

          return Parse.Promise.when(seats).then(function(){
            counters.events += 1;
            return event.save({"paymentRemindersSent": new Date()});
          });
        });
      });

      return Parse.Promise
      .when(done)
      .then(function(){
        console.log(counters.events + ' events, ' + counters.seatRequests + ' seat requests');
        status.success("payment reminders successfully sent for " + counters.seatRequests + " seat requests accross " + counters.events + " events.");
      });
    });

  })
  .fail(function(err){
    console.log(err);
    status.error(err.message + "(" + err.code + ")");
  });
});

// charge Users
Parse.Cloud.job("autoChargeUsers", function(request, status){
  // Set up to modify user data
  var moment = require('moment');

  Parse.Config.get().then(function(config) {
    var notificationTime = config.get("notificationTimeAfterEvent");
    var timeToFinalize = config.get("finalizeContributionTimeInHours");
    var SeatRequest = Parse.Object.extend("SeatRequest");
    var Event = Parse.Object.extend("event");

    // find users to notify that they need to pay still
    var query = new Parse.Query(SeatRequest);

    var transactionIdDoesNotExistQuery = new Parse.Query(SeatRequest);
    transactionIdDoesNotExistQuery.doesNotExist("transactionId");

    var transactionIdIsNullQuery = new Parse.Query(SeatRequest);
    transactionIdIsNullQuery.equalTo("transactionId", null);

    var transactionIdIsUndefinedQuery = new Parse.Query(SeatRequest);
    transactionIdIsUndefinedQuery.equalTo("transactionId", undefined);

    var transactionIdIsEmptyQuery = new Parse.Query(SeatRequest);
    transactionIdIsEmptyQuery.equalTo("transactionId", "");

    var query = new Parse.Query.or(transactionIdDoesNotExistQuery, transactionIdIsNullQuery, transactionIdIsUndefinedQuery, transactionIdIsEmptyQuery);
    
    query.doesNotExist("cancellationTransaction");
    query.equalTo("status", 1);
    query.notEqualTo("deleted", true);


    //var innerQuery = new Parse.Query(Event);
    //innerQuery.lessThan("startsAt", moment().subtract(timeToFinalize, "hours").toDate());

    //query.matchesQuery("event", innerQuery);
    var startsAtThreshold = new Date(moment().subtract(timeToFinalize, "seconds").toDate());

    query.include("event");
    query.include("user");
    query.include("event.host");
    query.include("event.host.hostRegistration");

    query.find({
      success: function(seats) {
        seats.forEach(function(seat) {
          if(seat.get("startsAt") > startsAtThreshold) return;
          console.log("autocharging user "+seat.get("user").id);
          var payload = {
              // amount: Math.ceil((seat.get("event").get("price") / (1-config.get("BOATDAY_PERC")) + config.get("BOATDAY_FEE")) / (1-config.get("BRAINTREE_PERC"))) * seat.get("numberOfSeats"),
              paymentToken: seat.get("user").get("braintreePaymentToken"),
              merchantId: seat.get("event").get("host").get("hostRegistration").get("merchantId")
            };
          console.log("autocharging user payload" + JSON.stringify(payload));
          Parse.Cloud.httpRequest({
            method: 'POST',
            url: 'https://boat-day-payments.herokuapp.com/seat-request/'+seat.id+'/auto-pay',
            body: payload,
            success: function(httpResponse) {
              console.log("autoChargeUsers success\n" + httpResponse.text);
            },
            error: function(httpResponse) {
              console.error("autoChargeUsers\n" + 'Request failed\n' + httpResponse.text);
            }
          });
        });
      }
    });

  }, function(error) {
    // Something went wrong (e.g. request timed out)
  });
});


// CLOUD FUNCTIONS
// ===============

Parse.Cloud.define("analytics", function(request, response) {
  var reports = {
    users: 0,
    hosts: 0,
    upcomingBoatDays: 0,
    seatRequests: 0,
    pendingHosts: 0,
    pendingCertifications: 0,
    newReports: 0,
    totalIncomeYear: 0,
    totalIncomeMonth: 0,
    totalIncomeQuarter: 0
  }

  if (!request.user) {
    response.error("Must be signed in to call this Cloud Function.")
    return;
  }

  var error = function(error) {
    response.error();
  }

  var countUsers = function(next) {
    // Count Users
    var query = new Parse.Query(Parse.User);
    query.notEqualTo("deleted", true);
    query.count({
      success: function(count) {
        reports.users = count;
        next();
      }, error: error
    });
  }

  var countPendingHosts = function(next) {
    // Count Pending Hosts
    var q = new Parse.Query(Parse.Object.extend("HostRegistration"));
    q.equalTo("status", 2);
    q.notEqualTo("deleted", true);
    q.count({
      success: function(count) {
        reports.pendingHosts = count;
        next();
      }, error: error
    })
  }

  var countHosts = function(next) {
    // Count Hosts
    var q = new Parse.Query(Parse.Object.extend("HostRegistration"));
    q.notEqualTo("deleted", true);
    q.equalTo("status", 1);
    q.count({
      success: function(count) {
        reports.hosts = count;
        next();
      }, error: error
    })
  }

  var countUpcomingBoatDays = function(next) {
    var q = (new Parse.Query(Parse.Object.extend("Event")));
    q.notEqualTo("deleted", true);
    q.greaterThan("startsAt", new Date());
    q.count({
      success: function(count) {
        reports.upcomingBoatDays = count;
        next();
      }, error: error
    })
  }

  var countSeatRequests = function(next) {
    var q = new Parse.Query(Parse.Object.extend("SeatRequest"));
    q.notEqualTo("deleted", true);
    q.count({
      success: function(count){
        reports.seatRequests = count;
        next();
      }, error: error
    })
  }

  var countPendingCertifications = function(next) {
    var q = new Parse.Query(Parse.Object.extend("Certification"));
    q.notEqualTo("deleted", true);
    q.equalTo("status", 2);
    q.count({
      success: function(count){
        reports.pendingCertifications = count;
        next();
      }, error: error
    })
  }

  var countNewReports = function(next) {
    var q = new Parse.Query(Parse.Object.extend("Report"));
    q.notEqualTo("deleted", true);
    q.notEqualTo("ignored", true);

    q.count({
      success: function(count){
        reports.newReports = count;
        next();
      }, error: error
    })
  }



  var query = new Parse.Query(Parse.Role);
  query.get("N514Ksmqqf",{
    success: function(adminRole) {
      var admins = adminRole.getUsers();

      admins.query().get(request.user.id, {
        success: function() {
          Parse.Cloud.useMasterKey();
          countUsers(function(){
            countPendingHosts(function(){
              countHosts(function(){
                countUpcomingBoatDays(function(){
                  countSeatRequests(function(){
                    countPendingCertifications(function(){
                      countNewReports(function(){
                        response.success(reports);
                      });
                    });
                  });
                });
              })
            })
          });
        },
        error: function() {
          response.error("Not an Admin.");
        }
      })

    },
    error: function(object, error) {
      response.error(error);
    }
  });  
});

// Used by CMS so that Admins can modify other users
Parse.Cloud.define("modifyUser", function(request, response) {
  if (!request.user) {
      response.error("Must be signed in to call this Cloud Function.")
      return;
    }

    var query = new Parse.Query(Parse.Role);
    query.get("N514Ksmqqf",{
      success: function(adminRole) {
        var admins = adminRole.getUsers();

        admins.query().get(request.user.id, {
          success: function() {

            Parse.Cloud.useMasterKey();

            var query = new Parse.Query(Parse.User);
            query.get(request.params.id, {
              success: function(user) {
                user.save(request.params.data, {
                  success: function(user) {
                    response.success(user);
                  },
                  error: function(error) {
                    response.error(error);
                  }
                });
              },
              error: function(error) {
                response.error(error);
              }
            });

          },
          error: function() {
            response.error("Not an Admin.");
          }
        })

      },
      error: function(object, error) {
        response.error(error);
      }
    });
});

/**
 * Soft-delete a user.
 * Used by CMS so that Admins can modify other users.
 *
 * @param {String} request.params.id id of the user to delete
 * @param {String} request.user.id id of the authenticated admin user calling this method
 * @return {Parse.Promise}
 */
Parse.Cloud.define("deleteUser", function(request, response) {
  if (!request.user) return response.error("Must be signed in to call this Cloud Function.");

  var query = new Parse.Query(Parse.Role);

  return query
  .get("N514Ksmqqf")
  .then(function(adminRole){
    var admins = adminRole.getUsers();

    return admins
    .query()
    .get(request.user.id)
    .then(function(){
      Parse.Cloud.useMasterKey();
      var query = new Parse.Query(Parse.User);

      return query
      .get(request.params.id)
      .then(function(user){
        user.set('deleted', true);

        return user
        .save()
        .then(function(){
          response.success(user);
        });
      });
    })
    .fail(function(err){
      response.error("Not an Admin");
    });
  })
  .fail(function(err){
    response.error(err);
  });
});


// AFTER AND BEFORE HOOKS
// ======================

afterSave(Parse.User, [
  ifDeleted(removeDependent("AdminMessage", "user")),
  ifDeleted(removeDependent("Boat", "owner")),
  ifDeleted(removeDependent("Certification", "user")),
  ifDeleted(removeDependent("ChatMessage", "user")),
  ifDeleted(removeDependent("Event", "host")),
  ifDeleted(removeDependent("HostRegistration", "user")),
  ifDeleted(removeDependent("Invite", "to")),
  ifDeleted(removeDependent("Invite", "from")),
  ifDeleted(removeDependent("Notification", "user")),
  ifDeleted(removeDependent("Report", "to")),
  ifDeleted(removeDependent("Report", "from")),
  ifDeleted(removeDependent("Review", "from")),
  ifDeleted(removeDependent("Review", "to")),
  ifDeleted(removeDependent("SeatRequest", "user")),
]);

afterSave("Boat", [
  setBoatACL,
]);

afterSave("Notification", [
  unlessDeleted(pushNotification),
]);

afterSave("Event", [
  ifDeleted(removeDependent("SeatRequest", "event")),
  unlessDeleted(ifCanceled(removeDependent("SeatRequest", "event"))),
]);

afterSave("SeatRequest", [
  ifDeleted(removeDependent("Notification", "seatRequest")),
  ifDeleted(removeSeatRequestFromEvent),
  ifDeleted(notifyUserAfterSeatRequestDeleted),
]);

afterSave("Review", [
  ifDeleted(removeReviewFromUsers),
  unlessDeleted(addUniqueReviewToUser),
]);


// PROMISES
// ========

function ifCanceled(fn){
  return function(instance){
    if (!instance.get('canceled')) return Parse.Promise.as();
    return fn(instance);
  }
}

function ifDeleted(fn){
  return function(instance){
    if (!instance.get('deleted')) return Parse.Promise.as();
    return fn(instance);
  }
}

function unlessDeleted(fn){
  return function(instance){
    if (instance.get('deleted')) return Parse.Promise.as();
    return fn(instance);
  }
}

function calculateGuestAmount(amount, seats) {
}

/**
 * Set ACL on `boat`.
 *
 * @param {Parse.Object} boat
 * @return {Parse.Promise}
 */
function setBoatACL(boat){
  var ACL = new Parse.ACL();
  ACL.setPublicReadAccess(true);
  ACL.setPublicWriteAccess(false);

  ACL.setWriteAccess(boat.get("owner").id, true);

  ACL.setRoleWriteAccess("admin", true);
  ACL.setRoleReadAccess("admin", true);

  boat.setACL(ACL);
  return boat.save();
}

/**
 * Remove associated seatRequest its Event record.
 *
 * @param {Parse.Object} seatRequest
 * @return {Parse.Promise}
 */
function removeSeatRequestFromEvent(seatRequest){
  return seatRequest
  .get("event")
  .fetch()
  .then(function(event){
    event.remove("seatRequests", seatRequest);
    return event.save();
  });
}

/**
 * Notify user the event for their seat request has been removed.
 *
 * @param {Parse.Object} seatRequest
 * @return {Parse.Promise}
 */
function notifyUserAfterSeatRequestDeleted(seatRequest){
  return seatRequest
  .get("event")
  .fetch()
  .then(function(event){
    return Parse.Config
    .get()
    .then(function(config) {
      var Notification = Parse.Object.extend("Notification");
      var notification = new Notification();

      return notification.save({
        user: seatRequest.get("user"),
        "event": seatRequest.get("event"),
        seatRequest: seatRequest,
        notificationType: config.get("notificationsTypes_eventRemoved"),
        text: config.get("notificationsMessages_eventRemoved"),
        read: false,
        sent: false,
        message: event.get('rejectionMessage'),
      });
    });
  });
}

/**
 * Remove a review from its `to` and `from` users.
 *
 * @param {Parse.Object} review
 * @return {Parse.Promise}
 */
function removeReviewFromUsers(review){
  var done = [];

  ["from", "to"].forEach(function(prop){
    done.push(
      review
      .get(prop)
      .fetch()
      .then(function(user){
        user.remove("reviews", review);
        return user.save();
      })
    );
  });

  return Parse.Promise.when(done);
}

/**
 * Add a review to its `to` user.
 *
 * @param {Parse.Object} review
 * @return {Parse.Promise}
 */
function addUniqueReviewToUser(review){
  if(!review.get("to")) return Parse.Promise.as();

  return review
  .get("to")
  .fetch()
  .then(function(user){
    user.addUnique("reviews", review);
    return user.save();
  });
}

/**
 * Pushes a notification to Apple's apn services.
 *
 * @param {Parse.Object} notification
 * @return {Parse.Promise}
 */
function pushNotification(notification){
  if(!notification.get("user") || notification.get("sent")) return Parse.Promise.as();

  var queries = [];

  var userQuery = new Parse.Query(Parse.User);
  userQuery.equalTo("objectId", notification.get("user").id);

  // Find devices associated with these users
  var pushQuery = new Parse.Query(Parse.Installation);
  pushQuery.matchesQuery('user', userQuery);

  var data = {
    alert: notification.get("text"),
    notificationId: notification.id,
    notificationType: notification.get("notificationType"),
  };

  // increment badge by default
  if(false !== notification.get("badge")) {
    data["badge"] = "Increment";
  }

  return Parse.Push
  .send({
    where: pushQuery,
    data: data,
  })
  .then(function(){
    notification.set("sent", true);
    return notification.save();
  });
}

/**
 * Soft delete a dependent attributes.
 * Returns a function that gets called with a Parse.Object and returns a Parse.Promise
 *
 * @param {String|Array} type
 * @param {String} attribute
 * @return {Function}
 *
 * The returned function will be called with a Parse.Object instance, and returns a Parse.Promise
 *
 * Usage:
 *   var removeSeatRequests = removeDependent("SeatRequest", "event");
 *
 *   removeSeatRequests(event)
 *   .then(function(){
 *     // seatRequests removed.
 *   })
 *   .fail(function(err){
 *     // seatRequests not removed.
 *   });
 */
function removeDependent(type, attribute){
  if (1 === arguments.length){
    attribute = type[1];
    type = type[0];
  }

  return function removeDependentRecord(instance){
    var query = new Parse.Query(type);
    query.equalTo(attribute, instance);
    query.notEqualTo("deleted", true);

    return query
    .find()
    .then(function(objs){
      if(!Array.isArray(objs)) { objs = [objs]; }

      var saved = [];

      objs.forEach(function(obj){
        obj.set('deleted', true);
        var saving = obj.save();
        saved.push(saving);
      });

      return Parse.Promise.when(saved);
    });
  }
}

/**
 * Combine beforeSave functions on Model.
 *
 * @param {String|Parse.Object} Model
 * @param {Function[]} actions
 *
 * Each function in `actions`
 *   - will be called with `request.object` as argument
 *   - must return a `Parse.Promise`
 */
function beforeSave(Model, actions){
  Parse.Cloud.beforeSave(Model, function(request, response) {
    var promises = actions.map(function(action){
      return action(request.object);
    });

    return Parse.Promise
    .when(promises)
    .then(function(){
      console.log('beforeSave success');
      response.success();
    })
    .fail(function(err){
      console.log('beforeSave error ' + err.code + ' ' + err.message);
      response.error(err);
    });
  });
}

/**
 * Combine afterSave functions on Model.
 *
 * @param {String|Parse.Object} Model
 * @param {Function[]} actions
 *
 * Each function in `actions`
 *   - will be called with `request.object` as argument
 *   - must return a `Parse.Promise`
 */
function afterSave(Model, actions){
  Parse.Cloud.afterSave(Model, function(request, response) {
    var promises = actions.map(function(action){
      return action(request.object);
    });

    return Parse.Promise
    .when(promises)
    .then(function(){
      console.log('afterSave success');
    })
    .fail(function(err){
      console.log('afterSave error ' + err.code + ' ' + err.message);
    });
  });
}
