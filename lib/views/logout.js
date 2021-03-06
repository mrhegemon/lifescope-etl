'use strict';

import config from 'config';
import express from 'express';

import { Remove } from '../sessions';

let router = express.Router();
let logout = router.route('/');

let domain = config.domain;


logout.get(function(req, res, next) {
	Remove(req)
		.then(function() {
			res.clearCookie(config.sessions.cookieName, {
				domain: domain,
				httpOnly: true
			});

			res.redirect('https://app.' + domain);
		})
		.catch(function(err) {
			next(err);
		});
});

export default router;
