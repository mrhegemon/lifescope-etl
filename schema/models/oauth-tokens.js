/* @flow */

import crypto from 'crypto';

import _ from 'lodash';
import { withFilter } from 'graphql-subscriptions';
import {graphql} from 'graphql-compose';
import composeWithMongoose from 'graphql-compose-mongoose/node8';
import config from 'config';
import httpErrors from 'http-errors';
import moment from 'moment';
import mongoose from 'mongoose';

import uuid from '../../lib/util/uuid';
import {OAuthAppTC} from "./oauth-apps";
import {OAuthTokenSessionTC} from "./oauth-token-sessions";


let urlRegex = /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)$/;

let validScopes = [
	'basic',
	'events',
	'contacts',
	'content',
	'locations'
];

let authorizationType = new graphql.GraphQLObjectType({
	name: 'authorization',
	fields: {
		code: graphql.GraphQLString,
		state: graphql.GraphQLString
	}
});

let tokenType = new graphql.GraphQLObjectType({
	name: 'token',
	fields: {
		access_token: graphql.GraphQLString,
		refresh_token: graphql.GraphQLString,
		expires_in: graphql.GraphQLString
	}
});


export const OAuthTokenSchema = new mongoose.Schema(
	{
		_id: {
			type: Buffer
		},

		id: {
			type: String,
			get: function() {
				if (this._id) {
					return this._id.toString('hex');
				}
			},
			set: function(val) {
				if (this._conditions && this._conditions.id) {
					if (this._conditions.id.hasOwnProperty('$in')) {
						this._conditions._id = {
							$in: _.map(this._conditions.id.$in, function(item) {
								return uuid(item);
							})
						};
					}
					else {
						this._conditions._id = uuid(val);
					}

					delete this._conditions.id;
				}

				if (val.hasOwnProperty('$in')) {
					this._id = {
						$in: _.map(val.$in, function(item) {
							return uuid(item);
						})
					};

				}
				else {
					this._id = uuid(val);
				}
			}
		},

		access_token: {
			type: String
		},

		app_id: {
			type: Buffer
		},

		app_id_string: {
			type: String,
			get: function() {
				return this.app_id.toString('hex')
			},
			set: function(val) {
				if (val && this._conditions && this._conditions.app_id) {
					this._conditions.app_id = uuid(val);

					delete this._conditions.app_id_string;
				}

				this.app_id = uuid(val);
			}
		},

		expires: Date,

		refresh_token: {
			type: String
		},

		scopes: {
			type: [String]
		},

		valid: Boolean,

		user_id: {
			type: Buffer
		},

		user_id_string: {
			type: String,
			get: function() {
				return this.user_id.toString('hex')
			},
			set: function(val) {
				if (val && this._conditions && this._conditions.user_id_string) {
					this._conditions.user_id = uuid(val);

					delete this._conditions.user_id_string;
				}

				this.user_id = uuid(val);
			}
		}
	},
	{
		collection: 'oauth_tokens',
	}
);


export const OAuthToken = mongoose.model('OAuthToken', OAuthTokenSchema);

export const OAuthTokenTC = composeWithMongoose(OAuthToken);


OAuthTokenTC.addResolver({
	name: 'authorization',
	kind: 'mutation',
	type: authorizationType,
	args: {
		response_type: 'String!',
		client_id: 'String!',
		redirect_uri: 'String!',
		scope: 'String',
		state: 'String'
	},
	resolve: async function({source, args, context, info}) {
		let scopes;
		let errors = [];

		if (args.response_type !== 'code' && args.response_type !== 'refresh_token') {
			errors.push('response_type must be \'code\' or \'refresh_token\'');
		}

		if (args.scope) {
			scopes = args.scope.split(',');

			let scopeErrorMessage = 'Invalid scopes: ';
			let scopeErrors = [];

			_.each(scopes, function(scope, index) {
				let lowercase = scope.toLowerCase();

				if (validScopes.indexOf(lowercase) < 0) {
					scopeErrors.push(lowercase);
				}

				scopes[index] = lowercase;
			});

			if (scopeErrors.length > 0) {
				errors.push(scopeErrorMessage.concat(scopeErrors.join(', ')));
			}
		}
		else {
			scopes = ['basic'];
		}

		let app = await OAuthAppTC.getResolver('findOne').resolve({
			args: {
				filter: {
					client_id: args.client_id
				}
			}
		});

		if (app == null) {
			errors.push('Invalid client_id');
		}

		if (app != null) {
			if (app.redirect_uris.indexOf(args.redirect_uri) < 0) {
				errors.push('Invalid redirect_uri');
			}
		}

		if (errors.length > 0) {
			return httpErrors(400, 'There were problems with your request -- ' + errors.join('; '));
		}
		else {
			await OAuthTokenSessionTC.getResolver('removeMany').resolve({
				args: {
					filter: {
						user_id_string: context.req.user._id.toString('hex')
					}
				}
			});

			let newSession = {
				id: uuid(),
				auth_code: crypto.randomBytes(16).toString('hex'),
				created: moment().utc().toDate(),
				client_id: args.client_id,
				redirect_uri: args.redirect_uri,
				scopes: scopes,
				user_id_string: context.req.user._id.toString('hex')
			};

			await OAuthTokenSessionTC.getResolver('createOne').resolve({
				args: {
					record: newSession
				}
			});

			return {
				code: newSession.auth_code,
				state: args.state
			};
		}
	}
});


OAuthTokenTC.addResolver({
	name: 'token',
	kind: 'mutation',
	type: tokenType,
	args: {
		grant_type: 'String!',
		code: 'String!',
		redirect_uri: 'String!',
		client_id: 'String!',
		client_secret: 'String!'
	},
	resolve: async function({source, args, context, info}) {
		let errors = [];

		if (args.grant_type !== 'authorization_code') {
			errors.push('grant_type must be \'authorization_code\'');
		}

		let session = await OAuthTokenSessionTC.getResolver('findOne').resolve({
			args: {
				filter: {
					auth_code: args.code
				}
			}
		});

		let app = await OAuthAppTC.getResolver('findOne').resolve({
			args: {
				filter: {
					client_id: args.client_id,
					client_secret: args.client_secret
				}
			}
		});

		if (session == null) {
			errors.push('Invalid code or code has expired');
		}

		if (app == null) {
			errors.push('client_id and/or client_secret are invalid');
		}

		if (session && session.redirect_uri !== args.redirect_uri) {
			errors.push('Invalid redirect_uri');
		}

		if (errors.length > 0) {
			return httpErrors(400, 'There were problems with your request -- ' + errors.join('; '));
		}
		else {
			let dateNow = moment();
			let expires = moment().utc().add(1, 'month');

			let newToken = {
				id: uuid(),
				access_token: crypto.randomBytes(32).toString('hex'),
				app_id: app._id.toString('hex'),
				expires: expires.toDate(),
				refresh_token: crypto.randomBytes(32).toString('hex'),
				scopes: session.scopes,
				user_id: app.user_id.toString('hex'),
				valid: true,
			};

			console.log(newToken);

			await OAuthTokenTC.getResolver('createOne').resolve({
				args: {
					record: newToken
				}
			});

			return {
				access_token: newToken.access_token,
				refresh_token: newToken.refresh_token,
				expires_in: expires.diff(dateNow, 'seconds')
			};
		}
	}
});