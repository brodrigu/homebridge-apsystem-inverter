const axios = require('axios');
const setupCache = require('axios-cache-adapter').setupCache;

var Service, Characteristic;

const DEF_MIN_LUX = 0,
      DEF_MAX_LUX = 10000;

const DEF_Watts = "Watts";
const DEF_KWH = "Kwh";

// Default API endpoints - updated to use HTTPS
const DEFAULT_API_BASE_URL = 'https://api.apsystemsema.com';
const DEFAULT_API_PATH = '/apsema/v1/ecu/getPowerInfo';
const DEFAULT_API_PORT = 443;

const PLUGIN_NAME   = 'homebridge-apsystem-inverter';
const ACCESSORY_NAME = 'APSystemsInverter';

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory(PLUGIN_NAME, ACCESSORY_NAME, APSystemsInverter);
}

/**
 * Setup Cache For Axios to prevent additional requests
 */
const cache = setupCache({
  maxAge: 5 * 1000 //in ms
})

const api = axios.create({
  adapter: cache.adapter,
  timeout: 10000 // Increased timeout for more reliable connections
})

function zformat_number2(n)
{
	return n > 9 ? ""+n:"0"+n;
}

/**
 * Main API request with all data
 *
 * @param {ecuId} ECU id
 * @param {apiBaseUrl} Optional API base URL (defaults to HTTPS endpoint)
 * @param {apiPath} Optional API path
 * @param {apiPort} Optional API port
 * @param {apiToken} Optional API authentication token
 */
const getInverterData = async(ecuId, apiBaseUrl, apiPath, apiPort, apiToken) => {
	try {
		let current_datetime = new Date();
		let day = zformat_number2(current_datetime.getDate());
		let month = zformat_number2(current_datetime.getMonth() + 1);
		let formatted_date = "" + current_datetime.getFullYear() + month + day;
		
		// Use provided API configuration or defaults
		const baseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
		const path = apiPath || DEFAULT_API_PATH;
		const port = apiPort || DEFAULT_API_PORT;
		
		// Build URL - handle both new HTTPS and legacy HTTP endpoints
		let url;
		if (port === 443 || !port) {
			url = `${baseUrl}${path}`;
		} else {
			url = `${baseUrl}:${port}${path}`;
		}
		
		// Prepare headers
		const headers = {
			'Content-Type': 'application/x-www-form-urlencoded'
		};
		
		// Add authentication token if provided
		if (apiToken) {
			headers['Authorization'] = `Bearer ${apiToken}`;
		}
		
		// Prepare request data
		const params = `filter=power&ecuId=${ecuId}&date=${formatted_date}`;
		
		return await api({
			method: 'POST',
			url: url,
			data: params,
			headers: headers,
			validateStatus: function (status) {
				return status >= 200 && status < 500; // Accept 2xx and 4xx as valid responses
			}
		});
	} catch (error) {
		if (error.response) {
			// The request was made and the server responded with a status code
			// that falls out of the range of 2xx
			console.error('API Error Response:', error.response.status, error.response.data);
		} else if (error.request) {
			// The request was made but no response was received
			console.error('API Error: No response received', error.message);
		} else {
			// Something happened in setting up the request that triggered an Error
			console.error('API Error:', error.message);
		}
		return null;
	}
}

/**
 * Gets and returns the accessory's value in the correct format.
 *
 * @param {ecuId} the ECU ID to be queried by getInverterData
 * @param {inverterDataValue} the JSON key queried with the return value
 * @param {apiBaseUrl} Optional API base URL
 * @param {apiPath} Optional API path
 * @param {apiPort} Optional API port
 * @param {apiToken} Optional API authentication token
 * @return {number} the value for the accessory
 */
const getAccessoryValue = async (ecuId, inverterDataValue, apiBaseUrl, apiPath, apiPort, apiToken) => {
	const inverterData = await getInverterData(ecuId, apiBaseUrl, apiPath, apiPort, apiToken);

	if (!inverterData || !inverterData.data) {
		return 0;
	}

	// Handle different response formats
	// Newer API might return data directly or in a different structure
	let responseData = inverterData.data;
	
	// Check if response has an error code
	if (responseData.code != null && responseData.code != 1) {
		return 0;
	}

	try {
		let value = 0;
		
		// Handle both old and new API response formats
		let timeData, powerData;
		
		if (responseData.data) {
			// Old format: data.data.time and data.data.power
			if (typeof responseData.data.time === 'string') {
				timeData = JSON.parse(responseData.data.time);
			} else {
				timeData = responseData.data.time;
			}
			
			if (typeof responseData.data.power === 'string') {
				powerData = JSON.parse(responseData.data.power);
			} else {
				powerData = responseData.data.power;
			}
		} else if (responseData.time && responseData.power) {
			// New format: direct time and power arrays
			timeData = typeof responseData.time === 'string' ? JSON.parse(responseData.time) : responseData.time;
			powerData = typeof responseData.power === 'string' ? JSON.parse(responseData.power) : responseData.power;
		} else {
			// Unknown format
			return 0;
		}

		if (!powerData || !Array.isArray(powerData) || powerData.length === 0) {
			return 0;
		}

		//Watts - return the last (most recent) power value
		if (inverterDataValue == DEF_Watts) {
			value = parseInt(powerData[powerData.length - 1]) || 0;
		}
		//Kwh - calculate total from all power values
		else {
			let kw_total = 0;
			for (let i = 0; i < powerData.length; i++) {
				let kw = parseInt(powerData[i]) || 0;
				kw_total = kw_total + ((kw * 0.08345) / 1000);
			}
			value = parseFloat(kw_total.toFixed(2));
		}
		
		return value;
	} catch (error) {
		console.error('Error parsing inverter data:', error.message);
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
	    this.ecuId = config["ecuId"];
	    this.inverter_data = config["inverter_data"];
	    this.minLux = config["min_lux"] || DEF_MIN_LUX;
    	this.maxLux = config["max_lux"] || DEF_MAX_LUX;
    	
    	// New API configuration options
    	this.apiBaseUrl = config["apiBaseUrl"] || DEFAULT_API_BASE_URL;
    	this.apiPath = config["apiPath"] || DEFAULT_API_PATH;
    	this.apiPort = config["apiPort"] || DEFAULT_API_PORT;
    	this.apiToken = config["apiToken"] || null;
    	
    	// For backward compatibility, support legacy HTTP endpoint
    	if (config["useLegacyApi"] === true) {
    		this.apiBaseUrl = 'http://api.apsystemsema.com';
    		this.apiPort = 8073;
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
			let getValue = await getAccessoryValue(
				this.ecuId, 
				this.inverter_data,
				this.apiBaseUrl,
				this.apiPath,
				this.apiPort,
				this.apiToken
			);

			this.log(`Current ${this.inverter_data}:`, getValue);

			callback(null, getValue);
		} catch (error) {
			this.log.error('Error getting inverter value:', error.message);
			callback(error);
		}
	}
}
