const axios = require('axios');
const crypto = require('crypto');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');

var Service, Characteristic;

const DEF_MIN_LUX = 0,
      DEF_MAX_LUX = 10000;

const DEF_Watts = "Watts";
const DEF_KWH = "Kwh";

// Web Dashboard API endpoints (session-based)
const DASHBOARD_API_BASE_URL = 'https://www.apsystemsema.com';
const DASHBOARD_DAILY_ENERGY_ENDPOINT = '/ema/ajax/getDashboardApiAjax/getDashboardUserDailyEnergyInLastWeekAjax';
const DASHBOARD_MONTHLY_ENERGY_ENDPOINT = '/ema/ajax/getDashboardApiAjax/getDashboardUserMonthlyEnergyInCurrentYearAjax';
const DASHBOARD_LOGIN_ENDPOINT = '/ema/security/login';

// Legacy API endpoint (for backward compatibility)
const LEGACY_API_BASE_URL = 'http://api.apsystemsema.com';
const LEGACY_API_PORT = 8073;
const LEGACY_API_PATH = '/apsema/v1/ecu/getPowerInfo';

const PLUGIN_NAME   = 'homebridge-apsystem-inverter';
const ACCESSORY_NAME = 'APSystemsInverter';

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    
    // Register accessory - class will be defined by the time this function is called
    // (since the entire file executes before Homebridge calls this function)
    homebridge.registerAccessory(PLUGIN_NAME, ACCESSORY_NAME, APSystemsInverter);
}

/**
 * Simple in-memory cache for API requests (5 second cache)
 */
const requestCache = new Map();
const CACHE_MAX_AGE = 5 * 1000; // 5 seconds

// Create cookie jar for proper cookie handling across requests
const cookieJar = new tough.CookieJar();

// Create axios instance with cookie jar support for login
const axiosInstance = wrapper(axios.create({
	timeout: 30000, // Increased timeout for login redirects
	jar: cookieJar, // Use cookie jar
	maxRedirects: 10, // Follow redirects for login
	headers: {
		'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
		'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
		'Accept-Language': 'en-US,en;q=0.9',
		'Accept-Encoding': 'gzip, deflate, br',
		'Connection': 'keep-alive',
		'Upgrade-Insecure-Requests': '1'
	}
}));

// Separate instance for API calls with different headers (also uses cookie jar)
const apiAxiosInstance = wrapper(axios.create({
	timeout: 10000,
	jar: cookieJar, // Share the same cookie jar
	headers: {
		'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
		'Accept': 'application/json, text/javascript, */*; q=0.01',
		'Accept-Language': 'en-US,en;q=0.9',
		'X-Requested-With': 'XMLHttpRequest',
		'Origin': 'https://www.apsystemsema.com',
		'Referer': 'https://www.apsystemsema.com/ema/security/optmainmenu/intoLargeDashboard.action?locale=en_US'
	}
}));

/**
 * Get cache key from request config
 */
function getCacheKey(config) {
	const url = config.url || '';
	const method = (config.method || 'get').toLowerCase();
	const params = JSON.stringify(config.params || {});
	const data = config.data ? (typeof config.data === 'string' ? config.data : JSON.stringify(config.data)) : '';
	return `${method}:${url}:${params}:${data}`;
}

/**
 * Clean up old cache entries
 */
function cleanupCache() {
	const now = Date.now();
	for (const [key, value] of requestCache.entries()) {
		if (now - value.timestamp > CACHE_MAX_AGE * 2) {
			requestCache.delete(key);
		}
	}
}

/**
 * Cached axios request wrapper
 */
async function cachedRequest(config) {
	// Only cache GET requests
	if (config.method && config.method.toLowerCase() === 'get') {
		const cacheKey = getCacheKey(config);
		const cached = requestCache.get(cacheKey);
		
		if (cached && (Date.now() - cached.timestamp) < CACHE_MAX_AGE) {
			// Return cached response
			return {
				data: cached.data,
				status: cached.status,
				headers: cached.headers,
				config: config,
				__fromCache: true
			};
		}
		
		// Make the request
		try {
			const response = await axiosInstance(config);
			
			// Cache successful responses
			if (response.status >= 200 && response.status < 300) {
				requestCache.set(cacheKey, {
					data: response.data,
					status: response.status,
					headers: response.headers,
					timestamp: Date.now()
				});
				
				// Clean up old entries periodically
				cleanupCache();
			}
			
			return response;
		} catch (error) {
			// If request failed but we have cached data, return it
			if (cached) {
				return {
					data: cached.data,
					status: cached.status,
					headers: cached.headers,
					config: config,
					__fromCache: true
				};
			}
			throw error;
		}
	}
	
	// For non-GET requests, just make the request normally
	return axiosInstance(config);
}

// Create API wrapper with caching
const apiInstance = {
	request: cachedRequest,
	get: (url, config) => cachedRequest({ ...config, method: 'get', url }),
	post: (url, data, config) => axiosInstance({ ...config, method: 'post', url, data }),
	put: (url, data, config) => axiosInstance({ ...config, method: 'put', url, data }),
	delete: (url, config) => axiosInstance({ ...config, method: 'delete', url })
};

function zformat_number2(n)
{
	return n > 9 ? ""+n:"0"+n;
}

/**
 * Parse cookies from Set-Cookie headers
 */
function parseCookies(setCookieHeaders) {
	const cookies = {};
	if (Array.isArray(setCookieHeaders)) {
		setCookieHeaders.forEach(cookie => {
			const parts = cookie.split(';')[0].split('=');
			if (parts.length === 2) {
				cookies[parts[0].trim()] = parts[1].trim();
			}
		});
	} else if (setCookieHeaders) {
		const parts = setCookieHeaders.split(';')[0].split('=');
		if (parts.length === 2) {
			cookies[parts[0].trim()] = parts[1].trim();
		}
	}
	return cookies;
}

/**
 * Format cookies for Cookie header
 */
function formatCookies(cookies) {
	return Object.entries(cookies)
		.map(([key, value]) => `${key}=${value}`)
		.join('; ');
}

/**
 * Build demo login URL from user ID
 * 
 * @param {demoUserId} Demo user ID
 * @returns {string} Demo login URL
 */
const buildDemoLoginUrl = (demoUserId) => {
	return `https://www.apsystemsema.com/ema/intoDemoUser.action?id=${demoUserId}&local=en_US`;
};

/**
 * Login to demo user and get session cookies
 * Cookie jar automatically handles cookies across redirects
 * 
 * @param {demoUrl} Demo login URL
 * @param {demoUserId} Demo user ID, used if demoUrl is not provided
 * @returns {object} Cookies object
 */
const getDemoSessionCookies = async(demoUrl, demoUserId) => {
	try {
		let url = demoUrl;
		if (!url) {
			if (!demoUserId) {
				throw new Error('demoUserId is required');
			}
			url = buildDemoLoginUrl(demoUserId);
		}
		
		// Clear cookie jar first
		cookieJar.removeAllCookies();
		
		// Make request to demo login URL - cookie jar will automatically handle cookies
		const response = await axiosInstance.get(url, {
			maxRedirects: 10, // Allow multiple redirects
			validateStatus: function (status) {
				return status >= 200 && status < 400; // Follow redirects
			}
		});
		
		// After login, visit the dashboard page to fully establish session
		// This ensures all necessary cookies are set (cookie jar handles this automatically)
		try {
			const dashboardUrl = 'https://www.apsystemsema.com/ema/security/optmainmenu/intoLargeDashboard.action?locale=en_US';
			
			await axiosInstance.get(dashboardUrl, {
				maxRedirects: 5,
				validateStatus: function (status) {
					return status >= 200 && status < 400;
				}
			});
		} catch (dashboardError) {
			// Dashboard visit failed, but we still have cookies from login
			console.error('Warning: Failed to visit dashboard after login:', dashboardError.message);
		}
		
		// Extract all cookies from the cookie jar
		const allCookies = {};
		const cookies = await cookieJar.getCookies('https://www.apsystemsema.com');
		cookies.forEach(cookie => {
			allCookies[cookie.key] = cookie.value;
		});
		
		return allCookies;
	} catch (error) {
		console.error('Error getting demo session cookies:', error.message);
		if (error.response) {
			console.error('Status:', error.response.status);
			console.error('Response URL:', error.response.request?.res?.responseUrl || error.config?.url);
		}
		return {};
	}
}

/**
 * Get dashboard data using session cookies
 * If cookies are provided, set them in the cookie jar first
 * Otherwise, use cookies already in the jar (from auto-login)
 * 
 * @param {cookies} Session cookies object (optional - will use jar if not provided)
 * @param {endpoint} API endpoint to call
 * @returns {object} Response data
 */
const getDashboardData = async(cookies, endpoint) => {
	try {
		const url = `${DASHBOARD_API_BASE_URL}${endpoint}`;
		
		// If cookies are provided, set them in the cookie jar
		if (cookies && Object.keys(cookies).length > 0) {
			// Clear existing cookies and set new ones
			cookieJar.removeAllCookies();
			for (const [key, value] of Object.entries(cookies)) {
				const cookie = new tough.Cookie({
					key: key,
					value: value,
					domain: 'www.apsystemsema.com',
					path: '/'
				});
				await cookieJar.setCookie(cookie, 'https://www.apsystemsema.com');
			}
		}
		
		// Make the API call - cookie jar will automatically send cookies
		const response = await apiAxiosInstance.post(url, '', {
		headers: {
			'Content-Length': '0',
			'Referer': 'https://www.apsystemsema.com/ema/security/optmainmenu/intoLargeDashboard.action',
			'Accept': 'application/json, text/javascript, */*; q=0.01',
			'Accept-Language': 'en-US,en;q=0.9'
		},
			validateStatus: function (status) {
				return status >= 200 && status < 500;
			}
		});
		
		// Check if response is HTML error page
		if (typeof response.data === 'string') {
			if (response.data.includes('<!DOCTYPE') || response.data.includes('EMA has encountered an error')) {
				// Response is HTML, likely an error page
				console.error('API returned HTML error page - session may be invalid');
				return null;
			}
			// Try to parse as JSON if it's a string
			try {
				response.data = JSON.parse(response.data);
			} catch (e) {
				// Not valid JSON
				console.error('Response is not valid JSON');
				return null;
			}
		}
		
		return response;
	} catch (error) {
		console.error('Dashboard API Error:', error.message);
		if (error.response) {
			console.error('Status:', error.response.status);
			// Only log data if it's not HTML (to avoid cluttering logs)
			if (typeof error.response.data === 'string' && error.response.data.includes('<!DOCTYPE')) {
				console.error('Received HTML error page - session may have expired');
			} else {
				console.error('Data:', error.response.data);
			}
		}
		return null;
	}
}

/**
 * Main API request - uses web dashboard API
 *
 * @param {useLegacyApi} Whether to use legacy API instead
 * @param {ecuId} ECU ID for legacy API
 * @param {demoLoginUrl} Demo login URL
 * @param {demoUserId} Demo user ID (used if demoLoginUrl is not provided)
 */
const getInverterData = async(useLegacyApi, ecuId, demoLoginUrl, demoUserId) => {
	try {
		if (useLegacyApi) {
			// Legacy API - POST request with form data
			let current_datetime = new Date();
			let day = zformat_number2(current_datetime.getDate());
			let month = zformat_number2(current_datetime.getMonth() + 1);
			let year = current_datetime.getFullYear();
			let formatted_date_legacy = "" + year + month + day;
			
			const url = `${LEGACY_API_BASE_URL}:${LEGACY_API_PORT}${LEGACY_API_PATH}`;
			const params = `filter=power&ecuId=${ecuId}&date=${formatted_date_legacy}`;
			
			try {
				const response = await apiInstance.post(url, params, {
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded'
					},
					validateStatus: function (status) {
						return status >= 200 && status < 500;
					}
				});
				
				// Check for 404 - legacy API might be deprecated
				if (response.status === 404) {
					console.error('Legacy API endpoint returned 404 - the endpoint may be deprecated.');
					console.error('Please remove "useLegacyApi: true" from your config and use "demoUserId" instead.');
					return null;
				}
				
				return response;
			} catch (error) {
				if (error.response && error.response.status === 404) {
					console.error('Legacy API endpoint returned 404 - the endpoint may be deprecated.');
					console.error('Please remove "useLegacyApi: true" from your config and use "demoUserId" instead.');
				}
				throw error;
			}
		}
		
		// Web Dashboard API - auto-login to demo user to get fresh cookies
		if (!demoLoginUrl && !demoUserId) {
			console.error('demoUserId or demoLoginUrl is required');
			return null;
		}
		
		const sessionCookies = await getDemoSessionCookies(demoLoginUrl, demoUserId);
		
		if (Object.keys(sessionCookies).length === 0) {
			console.error('Failed to get session cookies from demo login');
			return null;
		}
		
		// Get daily energy data (last week, includes today)
		const dailyResponse = await getDashboardData(sessionCookies, DASHBOARD_DAILY_ENERGY_ENDPOINT);
		
		if (!dailyResponse || !dailyResponse.data) {
			return null;
		}
		
		// Return the daily response which should contain today's data
		return dailyResponse;
		
	} catch (error) {
		if (error.response) {
			console.error('API Error Response:', error.response.status, error.response.data);
		} else if (error.request) {
			console.error('API Error: No response received', error.message);
		} else {
			console.error('API Error:', error.message);
		}
		return null;
	}
}

/**
 * Gets and returns the accessory's value from dashboard API
 *
 * @param {inverterDataValue} the JSON key queried with the return value ("Watts" or "Kwh")
 * @param {useLegacyApi} Whether to use legacy API
 * @param {ecuId} ECU ID for legacy API
 * @param {demoLoginUrl} Demo login URL
 * @param {demoUserId} Demo user ID (used if demoLoginUrl is not provided)
 * @return {number} the value for the accessory
 */
const getAccessoryValue = async (inverterDataValue, useLegacyApi, ecuId, demoLoginUrl, demoUserId) => {
	if (useLegacyApi) {
		// Use legacy API
		const inverterData = await getInverterData(true, ecuId, null, null);
		
		if (!inverterData || !inverterData.data) {
			return 0;
		}

		let responseData = inverterData.data;
		
		if (responseData.code != null && responseData.code != 1) {
			return 0;
		}

		try {
			let value = 0;
			let powerData;
			
			if (responseData.data) {
				if (typeof responseData.data.power === 'string') {
					powerData = JSON.parse(responseData.data.power);
				} else {
					powerData = responseData.data.power;
				}
			} else {
				return 0;
			}

			if (!powerData || !Array.isArray(powerData) || powerData.length === 0) {
				return 0;
			}

			if (inverterDataValue == DEF_Watts) {
				value = parseInt(powerData[powerData.length - 1]) || 0;
			} else {
				let kw_total = 0;
				for (let i = 0; i < powerData.length; i++) {
					let kw = parseInt(powerData[i]) || 0;
					kw_total = kw_total + ((kw * 0.08345) / 1000);
				}
				value = parseFloat(kw_total.toFixed(2));
			}
			
			return value;
		} catch (error) {
			console.error('Error parsing legacy inverter data:', error.message);
			return 0;
		}
	}
	
	// Use web dashboard API - auto-login to demo user
	if (!demoLoginUrl && !demoUserId) {
		console.error('demoUserId or demoLoginUrl is required');
		return 0;
	}
	
	const sessionCookies = await getDemoSessionCookies(demoLoginUrl, demoUserId);
	
	if (Object.keys(sessionCookies).length === 0) {
		console.error('Failed to get session cookies from demo login');
		return 0;
	}
	
	const dailyResponse = await getDashboardData(sessionCookies, DASHBOARD_DAILY_ENERGY_ENDPOINT);
	
	if (!dailyResponse || !dailyResponse.data) {
		return 0;
	}

	// Response should already be parsed JSON by getDashboardData, but double-check
	if (typeof dailyResponse.data === 'string') {
		try {
			dailyResponse.data = JSON.parse(dailyResponse.data);
		} catch (e) {
			console.error('Response is not valid JSON');
			return 0;
		}
	}

	try {
		let value = 0;
		const data = dailyResponse.data;
		
		// Parse the dashboard response format:
		// Daily: { "date": [timestamps...], "list": ["kWh values..."] }
		// Monthly: { "list": [values...] }
		// The last value in "list" is today's daily energy total (for daily endpoint)
		
		if (data && typeof data === 'object') {
			let energyList = [];
			
			// Check for the actual API response format
			if (data.list && Array.isArray(data.list)) {
				energyList = data.list;
			} else if (Array.isArray(data)) {
				// Fallback: if data is directly an array
				energyList = data;
			} else if (data.data && Array.isArray(data.data)) {
				// Another possible format
				energyList = data.data;
			}
			
			if (energyList.length > 0) {
				// Filter out null values and get the last valid value (today's energy)
				const validValues = energyList.filter(v => v !== null && v !== undefined && v !== '');
				if (validValues.length > 0) {
					const todayEnergy = parseFloat(validValues[validValues.length - 1]) || 0;
					
					if (inverterDataValue == DEF_Watts) {
						// For current watts, estimate from daily total
						// Since we only have daily totals, we approximate:
						// Average power = daily energy (kWh) / 24 hours * 1000 (to get watts)
						// This is a rough approximation - actual current power could vary
						value = Math.round((todayEnergy / 24) * 1000);
					} else {
						// For daily kWh total - return today's value
						value = parseFloat(todayEnergy.toFixed(2));
					}
				}
			}
		}
		
		return value || 0;
	} catch (error) {
		console.error('Error parsing dashboard data:', error.message);
		console.error('Response data:', JSON.stringify(dailyResponse.data, null, 2));
		return 0;
	}
}

class APSystemsInverter {
    constructor(log, config) {
    	this.log = log;
    	this.config = config;

    	this.service = new Service.LightSensor(this.config.name);

    	this.name = config["name"];
    	this.manufacturer = config["manufacturer"] || "AP Systems";
	    this.model = config["model"] || "Inverter";
	    this.serial = config["serial"] || "APSystems-inverter";
	    
	    // ECU ID for legacy API
	    this.ecuId = config["ecuId"];
	    
	    // For backward compatibility - explicitly check for true
	    // If not explicitly set to true, default to false (use web dashboard API)
	    this.useLegacyApi = config["useLegacyApi"] === true;
	    
	    // Warn if ecuId is provided but useLegacyApi is not true (might be old config)
	    if (this.ecuId && !this.useLegacyApi) {
	    	this.log.warn('ecuId is provided but useLegacyApi is not set to true. Ignoring ecuId and using web dashboard API.');
	    }
	    
	    this.inverter_data = config["inverter_data"];
	    this.minLux = config["min_lux"] || DEF_MIN_LUX;
    	this.maxLux = config["max_lux"] || DEF_MAX_LUX;
    	
    	// Demo login configuration - required
    	// Can provide either demoLoginUrl (full URL) or demoUserId (just the ID)
    	this.demoLoginUrl = config["demoLoginUrl"];
    	this.demoUserId = config["demoUserId"];
    	
    	// Validate that demo credentials are provided
    	if (!this.demoLoginUrl && !this.demoUserId) {
    		this.log.error('demoUserId or demoLoginUrl must be provided');
    		throw new Error('demoUserId or demoLoginUrl must be provided');
    	}
    	
    	// If demoLoginUrl is not provided but demoUserId is, build the URL
    	if (!this.demoLoginUrl && this.demoUserId) {
    		this.demoLoginUrl = buildDemoLoginUrl(this.demoUserId);
    	}
    }

    getServices () {
    	const informationService = new Service.AccessoryInformation()
        .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
        .setCharacteristic(Characteristic.Model, this.model)
        .setCharacteristic(Characteristic.SerialNumber, this.serial)


        this.service.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
		  .on('get', this.getCurrentAmbientLightLevelHandler.bind(this))
		  .setProps({
			minValue: this.minLux
		  });

	    return [informationService, this.service]
    }

    async getCurrentAmbientLightLevelHandler (callback) {
		try {
			if (this.useLegacyApi) {
				if (!this.ecuId) {
					this.log.error('ECU ID (ecuId) is required for legacy API');
					callback(new Error('ECU ID is required'));
					return;
				}
			}
			// Web dashboard API will auto-login to demo user
			
			let getValue = await getAccessoryValue(
				this.inverter_data,
				this.useLegacyApi,
				this.ecuId,
				this.demoLoginUrl,
				this.demoUserId
			);

			this.log(`Current ${this.inverter_data}:`, getValue);

			callback(null, getValue);
		} catch (error) {
			// Provide helpful error message for legacy API 404 errors
			if (error.response && error.response.status === 404 && this.useLegacyApi) {
				this.log.error('Legacy API endpoint returned 404 - the endpoint appears to be deprecated.');
				this.log.error('Please update your config: remove "useLegacyApi: true" and ensure "demoUserId" is set.');
				callback(new Error('Legacy API endpoint not found. Please use web dashboard API with demoUserId instead.'));
			} else {
				this.log.error('Error getting inverter value:', error.message);
				callback(error);
			}
		}
	}
}
