/**
 * ZUnoCompiler module compiles and uploads Z-Uno sketch to the attached Z-Uno. The QR code is printed in a div tag.
 */
var ZUnoCompiler = function() {
	const SOF_CODE							= 0x01;
	const NACK_CODE							= 0x15;
	const CAN_CODE							= 0x18;
	const ACK_CODE							= 0x06;
	const REQUEST_CODE						= 0x00;
	const RESPONSE_CODE						= 0x01;

	const SUCCESS_CODE						= 0x31;
	const FAIL_CODE							= 0x30;

	const WRITECYCLE_OK_CODE				= 0x0D;

	const RECV_OK 							= 0x00;
	const RECV_NOACK						= 0x01;
	const RECV_INVALIDDATALEN				= 0x02;
	const RECV_INVALIDCRC					= 0x03;
	const RECV_WRONGDATA					= 0x04;
	const RECV_NOSOF						= 0x05;

	const dtr_timeout						= 250;
	const rcv_sof_timeout					= 3500;
	const send_quant_size					= 240;

	const ADDITIONAL_SIZE					= 3;

	const ZUNO_HEADER_PREAMBL				= "ZMEZUNOC";

	const SK_START_OFFSET_OLD				= 0x30000;
	const SK_START_OFFSET					= 0x34800;
	const SK_HEADER_SIZE					= 0xC0;
	const SK_HEADER_VERSION_MSB_OFFSET			= 0x08;
	const SK_HEADER_VERSION_LSB_OFFSET			= 0x09;
	const SK_HEADER_SIZE_MSB_OFFSET			= 0x0A;
	const SK_HEADER_CRC_MSB_OFFSET			= 0x0C;
	const SK_HEADER_CRC_CALC_START			= 0xC0;
	const SK_HEADER_NAME_START				= 56;
	const SK_HEADER_MAX_NAME					= 47;
	const SK_HEADER_HWREW_OFFSET				= SK_HEADER_NAME_START + SK_HEADER_MAX_NAME + 1;

	const FREQ_TABLE_U7						= {"EU":0x00, "US":0x01, "ANZ":0x02, "HK": 0x03, "MY": 0x04, "IN":0x05,"IL": 0x06, "RU": 0x07, "CN": 0x08, "US_LR":0x09, "US_LR_BK":0x0A, "JP": 0x20, "KR":0x21, "FK":0xFE };

	const ZUNO_LIC_FLAGS_NAMES_PTI				= 0;
	const ZUNO_LIC_FLAGS_NAMES_KEY_DUMP			= 1;
	const ZUNO_LIC_FLAGS_NAMES_CUSTOM_VENDOR	= 2;
	const ZUNO_LIC_FLAGS_NAMES_MODEM			= 3;
	const ZUNO_LIC_FLAGS_NAMES_MAX_POWER		= 4;
	const ZUNO_LIC_FLAGS_NAMES_LONG_RANGE		= 5;

	const MAX_DEFAULT_RF_POWER					= 50

	const COM_PORT_FILTERS = [{ usbVendorId: 0x10c4, usbProductId: 0xea60 }];
	const ZUNO_BAUD = [230400, 230400*2, 230400*4, 115200];

	const CRC_POLY							= 0x1021;

	let progressCbk = null;
	function progress(severity, message) {
		if (progressCbk) {
			progressCbk(severity, message);
		}
	}
	
	function calcSigmaCRC16(crc, data, offset, llen) {
		let new_bit, wrk_data, b, a, bit_mask;
		let bin_data = data;
		while (llen != 0) {
			llen -= 1;
			if (offset >= bin_data.length)
				wrk_data = 0xFF;
			else
				wrk_data = bin_data[offset];
			offset += 1;
			bit_mask = 0x80;
			while (bit_mask != 0) {
				a = 0;
				b = 0;
				if ((wrk_data & bit_mask) != 0)
					a = 1;
				if ((crc & 0x8000) != 0)
					b = 1;
				new_bit = a ^ b;
				crc <<= 1;
				crc = crc & 0xffff;
				if (new_bit == 1){
					crc ^= CRC_POLY;
				}
				bit_mask >>= 1;
			}
		}
		return (crc);
	}

	function Checksum(data) {
		let ret = 0xff;
		let i = 0x0;
		while (i < data.length) {
			ret = ret ^ data[i];
			i++;
		}
		return (ret);
	}

	function sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	async function write(self, data) {
		// console.debug(">>", data);
		const data_uint8 = new Uint8Array(data);
		const writer = self["port"].writable.getWriter();
		await writer.write(data_uint8);
		writer.releaseLock();
	}

	async function sendNack(self) {
		await write(self, [NACK_CODE])
	}

	async function sendAck(self) {
		await write(self, [ACK_CODE])
	}

	async function readWithTimeout(self, timeout) {
		let out;
		const reader = self["port"].readable.getReader();
		const timer = setTimeout(() => {
			reader.releaseLock();
		}, timeout);
		try {
			const { value, done } = await reader.read();
			out = value;
		} catch (err) {
			out = [];
		}
		// console.debug("<<", out);
		clearTimeout(timer);
		reader.releaseLock();
		return (out);
	}

	async function read(self, num) {
		let out, i, rep;
		rep = 0x0;
		while (rep < 10) {
			if (self["queue"].length >= num) {
				out = [];
				i = 0x0;
				while (i < num) {
					out.push(self["queue"].shift())
					i++;
				}
				return (out);
			}
			const value = await readWithTimeout(self, 100);
			i = 0x0;
			while (i < value.length) {
				self["queue"].push(value[i])
				i++;
			}
			rep++;
		}
		if (num >= self["queue"].length)
			num = self["queue"].length;
		out = [];
		i = 0x0;
		while (i < num) {
			out.push(self["queue"].shift())
			i++;
		}
		return (out);
	}

	async function clear(self) {
		while (true) {
			const value = await readWithTimeout(self, 100);
			if (value.length == 0x0)
				return ;
		}
	}

	async function waitSOF(self) {
		const sof_timeout = Date.now() + rcv_sof_timeout;
		while (sof_timeout > Date.now()) {
			const sof = await read(self, 0x1);
			if (sof.length == 0x0) {
				await sleep(100);
				continue ;
			}
			if (sof[0x0] == SOF_CODE)
				return (true);
			await sleep(200);
		}
		return (false);
	}

	async function recvIncomingRequest(self) {
		let len_data, buff_data, test_buff, check_sum, check_buff;

		if (await waitSOF(self) == false)
			return ([RECV_NOSOF]);
		len_data = await read(self, 0x1);
		if (len_data.length == 0x0)
			return ([RECV_NOSOF]);
		len_data = len_data[0x0];
		buff_data = await read(self, len_data);
		test_buff = [SOF_CODE, len_data];
		test_buff = test_buff.concat(buff_data);
		if (buff_data.length != len_data) {
			await sendNack(self);
			return ([RECV_INVALIDDATALEN]);
		}
		check_buff = [len_data].concat(buff_data.slice(0, len_data - 0x1))
		check_sum = Checksum(check_buff);
		if (check_sum != buff_data[len_data - 1]) {
			await sendNack(self);
			return ([RECV_INVALIDCRC]);
		}
		await sendAck(self);
		return ([RECV_OK].concat(check_buff));
	}

	async function resyncZunoPort(self) {
		if (navigator.platform = "Win32")
			await sleep(500);
		let data = await recvIncomingRequest(self);
		if (data[0x0] != RECV_OK)
			return (false);
		return (true);
	}

	async function sendData(self, cmd, databuff, have_callback = false) {
		let crc_data, final_data, crc16;
		let data_len = databuff.length + ADDITIONAL_SIZE;
		if (have_callback == true)
			data_len++;
		if (data_len > 255) {
			crc_data = [0x00, REQUEST_CODE, cmd].concat(databuff);
			final_data = [0x00, (data_len >> 8)& 0x0FF, data_len & 0x0FF, REQUEST_CODE, cmd].concat(databuff);
			if (have_callback == true)
				final_data = final_data.concat([self["seqNo"]]);
			crc16 = calcSigmaCRC16(0x1D0F, crc_data, 0, crc_data.length);
			final_data = [SOF_CODE].concat(final_data).concat([(crc16 >> 8) & 0xFF, (crc16) & 0xFF]);
			await write(self, final_data);
			self["seqNo"] += 1;
			self["seqNo"] &= 0XFF;// 1 byte
			return ;
		}
		final_data = [data_len & 0x0FF, REQUEST_CODE, cmd].concat(databuff);
		if (have_callback == true)
			final_data = final_data.concat([self["seqNo"]]);
		crc = Checksum(final_data);
		final_data = [SOF_CODE].concat(final_data).concat([crc]);
		await write(self, final_data);
		self["seqNo"] += 1;
		self["seqNo"] &= 0XFF;// 1 byte
	}

	async function sendCommandUnSz(self, cmd, databuff, have_callback = false, retries = 0x3) {
		let rbuff, result;
		// In case of unclean buffer
		await clear(self);
		while (true) {
			await sendData(self, cmd, databuff, have_callback);
			rbuff = await read(self, 0x1)
			if (rbuff.length == 0x0)
				return ([RECV_NOACK]);
			if (rbuff[0] == ACK_CODE)
				break ;
			if (rbuff[0] == CAN_CODE) {
				// console.warn("!!!CANCODE");
				await recvIncomingRequest(self);
				retries -= 1;
				if (retries > 0)
					continue ;
			}
			if (rbuff[0] == NACK_CODE) {
				// console.debug("!!!NACK");
				retries -= 1;
				if (retries > 0)
					continue ;
			}
			return ([RECV_NOACK]);
		}
		result = await recvIncomingRequest(self);
		return (result);
	}

	async function readNVM(self, addr, size) {
		return (await sendCommandUnSz(self, 0x2A, [(addr >> 16) & 0xFF, (addr >> 8) & 0xFF, addr & 0xFF, (size >> 8) & 0xFF, size & 0xFF], false));
	}

	async function writeNVM(self, addr, buff) {
		const size = buff.length;
		const data_addr = [(addr >> 16) & 0xFF, (addr >> 8) & 0xFF, addr & 0xFF, (size >> 8) & 0xFF, size & 0xFF];
		return (await sendCommandUnSz(self, 0x2B, data_addr.concat(buff), false));
	}

	async function checkBootImage(self) {
		return (sendCommandUnSz(self, 0x08, [0x04], false));
	}

	async function pushSketch(self, addr, size, crc16) {
		return sendCommandUnSz(self, 0x08, [0x01, (addr >> 16) & 0xFF, (addr >> 8) & 0xFF, addr & 0xFF, (size >> 8) & 0xFF, size & 0xFF, (crc16 >> 8) & 0xFF, (crc16) & 0xFF], false);
	}

	function zmeRemapDictVal2Key(d, val) {
		for (let k in d) {
			if (d[k] == val)
				return (k);
		}
		return (null);
	}

	function zme_costruct_int(arr, n, inv = true) {
		let val, i, indx;
		val =0;
		i = 0x0;
		while (i < arr.length) {
			val <<= 8;
			indx = i;
			if (inv == true)
				indx = n-1-i
			if ((indx < arr.length) && (indx >= 0))
				val += arr[indx];
			i++;
		}
		return (val);
	}

	function readBoardInfoCheckFlag(lic_flags, flag_bit) {
		let byte, flag;

		byte = ((flag_bit - (flag_bit % 0x8)) / 0x8)
		if (lic_flags.length < byte)
			return (false);
		flag = lic_flags[byte];
		if ((flag & (0x1 << (flag_bit % 0x8))) == 0x0)
			return (false);
		return (true);
	}

	function conv2Decimal(buff, separator="-") {
		let i = 0x0, text = "";
		while (i < (buff.length / 2)) {
			v = buff[ (i * 2)];
			v <<= 8;
			v += buff[ (i * 2) + 1];
			if(i != 0)
				text += separator;
			text += _compile_zwave_qrcode_padding(v, 5);
			i = i + 1;
		}
		return (text)
	}

	function _compile_zwave_qrcode_padding(num, max) {
		let num_str = num.toString(0xA);
		while (num_str.length < max)
			num_str = '0' + num_str;
		return (num_str);
	}

	async function compile_zwave_qrcode(product_data, dsk, version) {
		let protocol_map, text;
		text = _compile_zwave_qrcode_padding(product_data["s2_keys"], 3);
		text = text + conv2Decimal(dsk,"");
		// #ProductType
		text = text + "0010" + _compile_zwave_qrcode_padding(product_data["device_type"], 5) + _compile_zwave_qrcode_padding(product_data["device_icon"], 5);
		// #ProductID
		text = text + "0220" + _compile_zwave_qrcode_padding(product_data["vendor"], 5) + _compile_zwave_qrcode_padding(product_data["product_type"], 5) +
				_compile_zwave_qrcode_padding(product_data["product_id"], 5) + _compile_zwave_qrcode_padding(version, 5);
		// # Supported Protocols
		protocol_map = 0x01;
		if (product_data["LR"] == true)
			protocol_map = protocol_map | 0x02;
		text += "0803" + _compile_zwave_qrcode_padding(protocol_map, 3);
		// # MaxInclusionInterval
		text = text + "0403005";// # ==5*128=640
		const buf = Uint8Array.from(unescape(encodeURIComponent(text)), c=>c.charCodeAt(0)).buffer;
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
		text = "9001" + _compile_zwave_qrcode_padding((digest[0x0] << 0x8) | digest[0x1], 5) + text;
		return (text);
	}

	function toString(array) {
		let result = "";
		for (let i = 0; i < array.length; i++) {
			result += String.fromCharCode(array[i]);
		}
		return result;
	}

	async function readBoardInfo(self, bSketchMD = false, bKeys = true) {
		let md, bLR, info, param_info, r, bts, code_sz_shift, shift_smrt, prod_shift, lic_shift, lic_flags;
		md = {};
		info = await readNVM(self, 0xFFFF00, 0x01);
		if (info.length < 10)
			return (md);
		param_info = await readNVM(self, 0xFFE000, 0x09);
		if (param_info.length < 10)
			return (md);
		bLR = false;
		param_info = param_info.slice(4, param_info.length);
		r = zmeRemapDictVal2Key(FREQ_TABLE_U7, param_info[1])
		if (r != null)
			if ((r == "US_LR") || (r == "US") ||  (r == "US_LR_BK"))
				bLR = true;
		bts = info.slice(4, info.length);
		md["version"] = (bts[0] << 8) | (bts[1]);
		md["build_number"] = (bts[2] << 24) | (bts[3] << 16) |  (bts[4] << 8) | (bts[5]);
		md["build_ts"] = (bts[6] << 24) | (bts[7] << 16) |  (bts[8] << 8) | (bts[9]);
		md["hw_rev"] =  (bts[10] << 8) | (bts[11]);
		code_sz_shift = 0;
		if( md["build_number"] > 1116) {
			code_sz_shift = 1;
			md["code_size"] = zme_costruct_int(bts.slice(12,12+3), 3, false);
		}
		else
			md["code_size"] =  (bts[12] << 8) | (bts[13]);
		md["ram_size"] =  (bts[14+code_sz_shift] << 8) | (bts[15+code_sz_shift]);
		md["chip_uid"] =  bts.slice(16+code_sz_shift,16+code_sz_shift+8);
		md["s2_pub"] =  bts.slice(24+code_sz_shift,24+code_sz_shift+16);
		md["dsk"] = conv2Decimal(md["s2_pub"],"-");
		md["dbg_lock"] =  0xFF;
		md["home_id"] = 0;
		md["node_id"] = 0;
		md["custom_code_offset"] = SK_START_OFFSET_OLD;
		if (bts.length > (44+code_sz_shift)) {
			md["dbg_lock"] = bts[40+code_sz_shift];
			md["home_id"] = zme_costruct_int(bts.slice(41+code_sz_shift,41+code_sz_shift+4), 4, false);
			md["node_id"] = bts[45+code_sz_shift];
		}
		shift_smrt = 11;
		if (bts.length > (46+code_sz_shift)) {
			if (md["build_number"] < 1669) {
				shift_smrt = 90;
				md["smart_qr"] = toString(bts.slice(46+code_sz_shift,46+code_sz_shift+90));
			}
			else {
				md["zwdata"] = {};
				md["zwdata"]["s2_keys"] = bts[46+code_sz_shift];
				md["zwdata"]["device_type"] = zme_costruct_int(bts.slice(47+code_sz_shift, 47+code_sz_shift+2), 2, false);
				md["zwdata"]["device_icon"] = zme_costruct_int(bts.slice(49+code_sz_shift, 49+code_sz_shift+2), 2, false);
				md["zwdata"]["vendor"] = zme_costruct_int(bts.slice(51+code_sz_shift, 51+code_sz_shift+2), 2, false);
				md["zwdata"]["product_type"] = zme_costruct_int(bts.slice(53+code_sz_shift, 53+code_sz_shift+2), 2, false);
				md["zwdata"]["product_id"] = zme_costruct_int(bts.slice(55+code_sz_shift, 55+code_sz_shift+2), 2, false);
				md["zwdata"]["version"] = md["version"];
				md["zwdata"]["LR"] = bLR;
				md["smart_qr"] = await compile_zwave_qrcode(md["zwdata"], md["s2_pub"], md["version"]);
			}
		}
		md["boot_offset"] = 0x3a000;
		if (bts.length > (46+shift_smrt+code_sz_shift+4)) {
			md["custom_code_offset"] = zme_costruct_int(bts.slice(46+code_sz_shift+shift_smrt,46+code_sz_shift+shift_smrt+4), 4, false)
			if(md["custom_code_offset"] > 0x36000)
				md["boot_offset"] = 0x40000;
		}
		md["max_default_power"] = MAX_DEFAULT_RF_POWER;
		lic_flags = [0];
		if (bts.length > (46+shift_smrt+code_sz_shift+8)) {
			prod_shift = 46+code_sz_shift+shift_smrt+4;
			lic_shift = prod_shift+8+4+4;
			lic_flags = bts.slice(lic_shift+2,lic_shift+2+8);
			if (bts.length > (lic_shift + 10) && md["build_number"] >= 2849)
				md["max_default_power"] = bts[lic_shift+10]
		}
		if (readBoardInfoCheckFlag(lic_flags, ZUNO_LIC_FLAGS_NAMES_MAX_POWER) == false)
			md["flag_max_power"] = false;
		else
			md["flag_max_power"] = true;
		md["param_info"] = param_info;
		return (md);
	}

	async function freezeSketch(self, retries = 50) {
		let sleep_time;
		sleep_time = 10;
		if (navigator.platform = "Win32")
			sleep_time = 50;
		while (retries != 0x0) {
			rcv = await sendCommandUnSz(self, 0x08, [0x02], false);
			if (rcv.length > 4) {
			if ((rcv[0] == RECV_OK) && (rcv[3] == 0x08) && (rcv[4] == 0x00))
				return (true);
			}
			await sleep(sleep_time);
			retries -= 1;
		}
		return (false);
	}

	async function syncWithDevice(self) {
		if (await resyncZunoPort(self) == false) {
			return (false);
		}
		if (await freezeSketch(self) == false) {
			return (false);
		}
		return (true);
	}

	function HeaderCmp(header, core_version, hw_rev, build_number) {
		let header_version, header_hw_rev;
		const data_uint8 = new Uint8Array(header.slice(0, ZUNO_HEADER_PREAMBL.length));
		const string = new TextDecoder().decode(data_uint8);
		if (ZUNO_HEADER_PREAMBL != string)
			return (false);
		header_version = (header[SK_HEADER_VERSION_MSB_OFFSET] << 8) | header[SK_HEADER_VERSION_LSB_OFFSET];
		if (header_version != core_version)
			return (false);
		if(hw_rev != -1 && build_number >= 2849) {
			header_hw_rev = zme_costruct_int(header.slice(SK_HEADER_HWREW_OFFSET, SK_HEADER_HWREW_OFFSET + 0x2), 2);
			if(hw_rev != header_hw_rev)
				return (false);
		}
		return (true);
	}

	async function writeArrayToNVM(self, md, nvmaddr, array, data_offset=0) {
		let ret_data, data_quant, offset, data_remains, data_writed, len_send, buff, res;

		ret_data = array;
		offset = data_offset;
		data_remains = ret_data.length - data_offset;
		data_quant = 240;
		if (md["build_number"] >= 3396)
			data_quant = 2048;
		data_writed = 0;
		while (data_remains != 0x0) {
			// console.log("Writing NVM data", (data_writed * 100.0) / (ret_data.length));
			len_send = data_quant;
			if (data_remains < data_quant)
				len_send = data_remains;
			buff = new Array();
			buff = buff.concat(ret_data.slice(offset,offset + len_send));
			if (buff.length == 1)
				buff = buff.concat([0xFF]);
			res = await writeNVM(self, nvmaddr, buff);
			if (res[0] != RECV_OK || res[4] != 1)
				return (null);
			offset += len_send;
			data_remains -= len_send;
			data_writed += len_send;
			nvmaddr += len_send;
		}
		// console.log("Writing NVM data", "OK");
		return (ret_data);
	}

	async function applyPrams(self, md) {
		let bts, min_len, res;

		bts = md["param_info"];
		min_len = 8;
		while (bts.byteLength < min_len)
			bts.push(0x0);
		bts[1] = self["paramtr"]["freq"];
		if (bts.byteLength > 8)
			bts[8] = self["paramtr"]["freq"];
		bts[4] = self["paramtr"]["sec"];
		bts[2] = self["paramtr"]["main_pow"];
		res = await writeNVM(self, 0xFFE000, bts);
		if (res[0] != RECV_OK || res[4] != 1) {
			return (false);
		}
		return (true);
	}

	async function waitFinware(self) {
		let result;
		const sof_timeout = Date.now() + 30000;
		while (sof_timeout > Date.now()) {
			result = await recvIncomingRequest(self);
			if (result[0] == RECV_OK) {
				if (result.length < 6)
					return (false);
				if (result[3] != 0x08)
					return (false);
				if (result[5] != 0x01)
					return (false);
				return (true);
			}
			await sleep(100);
		}
		return (false);
	}

	function _base64ToArrayBuffer(base64) {
		const binaryString = atob(base64);
		const bytes = new Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	function _xhr_compile(data, hw_str) {
		return new Promise(function(resolve, reject) {
			const xhr = new XMLHttpRequest();
			const formData = new FormData();

			formData.append("sketch", new File([new Blob([data])], "sketch", { lastModified: new Date(0), type: "text/x-arduino", size: data.length, name:"sketch" }));
			const url = 'https://service.z-wave.me/z-uno-compilation-server/?compile&' + 'hw=' + hw_str;
			xhr.open("POST", url);
			xhr.responseType = 'json';
			xhr.timeout = 300000;//5 min
			xhr.ontimeout = function () {
				reject(Error("Request failed: Timed out"));
			};
			xhr.onload = function () {
				resolve(xhr.response);
			};
			xhr.onerror = function () {
				reject(Error("Request failed: Perhaps you have problems with the Internet"));
			};

			xhr.send(formData);
		});
	}

	function _xhr_version() {
		return new Promise(function(resolve, reject) {
			const xhr = new XMLHttpRequest();

			xhr.open("POST", 'https://service.z-wave.me/z-uno-compilation-server/?version');
			xhr.responseType = 'json';
			xhr.timeout = 30000;//30 sec
			xhr.ontimeout = function () {
				reject(Error("Request failed: Timed out"));
			};
			xhr.onload = function () {
				resolve(xhr.response);
			};
			xhr.onerror = function () {
				reject(Error("Request failed: Perhaps you have problems with the Internet"));
			};
			xhr.send();
		});
	}

	function _xhr_bootloader(hw_str, build_number) {
		return new Promise(function(resolve, reject) {
			const xhr = new XMLHttpRequest();

			const url = 'https://service.z-wave.me/z-uno-compilation-server/?bootloader&' + 'hw=' + hw_str + "&seq=" + build_number;
			xhr.open("POST", url);
			xhr.responseType = 'json';
			xhr.timeout = 30000;//30 sec
			xhr.ontimeout = function () {
				reject(Error("Request failed: Timed out"));
			};
			xhr.onload = function () {
				resolve(xhr.response);
			};
			xhr.onerror = function () {
				reject(Error("Request failed: Perhaps you have problems with the Internet"));
			};
			xhr.send();
		});
	}

	async function sketch_info(message) {
		progress("info", message);
	}
	
	async function sketch_error(self, reject, result) {
		if (self != null)
			await self["port"].close();
		progress("error", result.message);
		reject(result);
	}

	function load_sketch(self, resolve, reject) {
		sketch_info("Uploading the sketch");
		self["promise_compile"].then(async function(result) {
			let bin, header, md, sk_data, res;
			try {
				if (result["status"] != 0x0)
					return (sketch_error(self, reject, Error("Compilation returned incorrect status: " + result["status"] + " log: " + result["log"] + " message: " +  result["message"])));
				bin = _base64ToArrayBuffer(result["bin"]);
			} catch (error) {
				return (sketch_error(self, reject, Error("The structure obtained after compilation is not valid")));
			}
			md = self["md"];
			header = bin.slice(0, SK_HEADER_SIZE);
			if (HeaderCmp(header, md["version"], md["hw_rev"], md["build_number"]) == false)
				return (sketch_error(self, reject, Error("The sketch and firmware version do not match")));
			if (bin.length > md["code_size"])
				return (sketch_error(self, reject, Error("Sketch size too large")));
			if (await applyPrams(self, md) == false)
				return (sketch_error(self, reject, Error("Failed to apply settings")));
			sk_data = await writeArrayToNVM(self, md, md["custom_code_offset"], bin);
			if (sk_data == null)
				return (sketch_error(self, reject, Error("Failed to upload sketch")));
			crc16 = calcSigmaCRC16(0x1D0F, sk_data, 0, sk_data.length);
			res = await pushSketch(self, md["custom_code_offset"], sk_data.length, crc16);
			if (res[0] != RECV_OK)
				return (sketch_error(self, reject, Error("Failed to apply sketch")));
			if(res[4] == 0xFE)
				return (sketch_error(self, reject, Error("Can't upload sketch! Something went wrong. Bad CRC16 :'( .")));
			await self["port"].close();
			await sleep(dtr_timeout);// The time for the capasitor on the DTR line to recharge
			await self["port"].open({ baudRate: self["baudRate"], bufferSize: 8192 });
			if (await syncWithDevice(self) == false)
				return (sketch_error(null, reject, Error("After a successful firmware update, it was not possible to re-sync with Z-Uno")));
			self["md"] = await readBoardInfo(self);
			if (Object.keys(self["md"]).length == 0x0)
				return (sketch_error(self, reject, Error("Failed to read board info")));
			await self["port"].close();
			const out = {};
			out["dsk"] = self["md"]["dsk"];
			if ("smart_qr" in self["md"]) {
				out["smart_qr"] = self["md"]["smart_qr"];
				resolve(out);
				return ;
			}
			return (sketch_error(self, reject, Error("Failed to read qr code")));
		}, async function(err) {
			return (sketch_error(self, reject, err));
		});
	}

	function load_bootloader(self, resolve, reject, hw_str, build_number_str) {
		sketch_info("Uploading a new bootloader to the Z-Uno");
		const promise_bootloader = _xhr_bootloader(hw_str, build_number_str);
		promise_bootloader.then(async function(result) {
			let bin, sk_data;

			try {
				if (result["status"] != 0x0)
					return (sketch_error(self, reject, Error("Get bootloader returned incorrect status: " + result["status"] + " log: " + result["log"] + " message: " +  result["message"])));
				bin = _base64ToArrayBuffer(result["bin"]);
			} catch (error) {
				return (sketch_error(self, reject, Error("The bootloader structure obtained after version is not valid")));
			}
			sk_data = await writeArrayToNVM(self, self["md"], self["md"]["boot_offset"], bin);
			if (sk_data == null)
				return (sketch_error(self, reject, Error("Failed to upload firmware")));
			res = await checkBootImage(self);
			if (await waitFinware(self) == false)
				return (sketch_error(self, reject, Error("Something is wrong - the firmware could not be updated - there may be a problem with the version")));
			await waitFinware(self);
			await self["port"].close();
			await sleep(dtr_timeout);// The time for the capasitor on the DTR line to recharge
			await self["port"].open({ baudRate: self["baudRate"], bufferSize: 8192 });
			if (await syncWithDevice(self) == false)
				return (sketch_error(null, reject, Error("After a successful firmware update, it was not possible to re-sync with Z-Uno")));
			self["md"] = await readBoardInfo(self);
			if (Object.keys(self["md"]).length == 0x0)
				return (sketch_error(self, reject, Error("Failed to read board info")));
			if (Number(build_number_str) != self["md"]["build_number"])
				return (sketch_error(self, reject, Error("Although the firmware was successfully updated, the actual version was no longer needed")));
			return (load_sketch(self, resolve, reject));
		}, async function(err) {
			return (sketch_error(self, reject, err));
		});
	}

	function sketch(text_sceth, hw, freq, sec, main_pow) {
		return new Promise(async function(resolve, reject) {
			const self = {"queue":[], "seqNo": 0x0};
			const paramtr = {};
			if (!(freq in FREQ_TABLE_U7))
				return (sketch_error(null, reject, Error("The specified radio frequency is not supported")));
			paramtr["freq"] = FREQ_TABLE_U7[freq];
			if (sec === true)
				paramtr["sec"] = 0x1;
			else if (sec === false)
				paramtr["sec"] = 0x0;
			else
				return (sketch_error(null, reject, Error("The security parameter is incorrectly specified")));
			if (main_pow < 0x1 || main_pow > 0xFF)
				return (sketch_error(null, reject, Error("Radio power is out of range")));
			paramtr["main_pow"] = main_pow;
			self["paramtr"] = paramtr;
			let i, hw_str;
			hw_str = hw.toString(0x10);
			while (hw_str.length < 0x4)
				hw_str = '0' + hw_str;
			self["promise_version"] = _xhr_version();
			self["promise_compile"] = _xhr_compile(text_sceth, hw_str);
			const filters = COM_PORT_FILTERS;
			try {
				self["port"] = await navigator.serial.requestPort({filters});
			} catch(e) {
				return (sketch_error(null, reject, Error("No port selected")));
			}
			sketch_info("Checking Z-Uno version");
			i = 0x0;
			while (i < ZUNO_BAUD.length) {
				await self["port"].open({ baudRate: ZUNO_BAUD[i], bufferSize: 8192 });
				if (await syncWithDevice(self) == true)
					break ;
				await self["port"].close();
				await sleep(dtr_timeout);// The time for the capasitor on the DTR line to recharge
				i++;
			}
			if (i >= ZUNO_BAUD.length)
				return (sketch_error(null, reject, Error("Failed to sync with Z-Uno")));
			self["baudRate"] = ZUNO_BAUD[i];
			self["md"] = await readBoardInfo(self);
			if (Object.keys(self["md"]).length == 0x0)
				return (sketch_error(self, reject, Error("Failed to read board info")));
			if (self["md"]["flag_max_power"] == false) {
				if (main_pow > self["md"]["max_default_power"])
					return (sketch_error(self, reject, Error("Your license does not support this maximum radio power value.")));
			}
			if (self["md"]["hw_rev"] != hw)
				return (sketch_error(self, reject, Error("Board revision does not match")));
			self["promise_version"].then(async function(result) {
				let version_list, build_number;
				try {
					if (result["status"] != 0x0)
						return (sketch_error(self, reject, Error("Get version returned incorrect status: " + result["status"] + " message: " +  result["message"])));
					version_list = result["version"]["hw"];
				} catch (error) {
					return (sketch_error(self, reject, Error("The version structure obtained after version is not valid")));
				}
				build_number = version_list[hw_str];
				if (build_number === undefined)
					return (sketch_error(self, reject, Error("The server does not support the specified board revision")));
				if (self["md"]["build_number"] > Number(build_number))
					return (sketch_error(self, reject, Error("The firmware on the board is newer than on the server")));
				if (self["md"]["build_number"] != Number(build_number))
					return (load_bootloader(self, resolve, reject, hw_str, build_number));
				return (load_sketch(self, resolve, reject));
			}, async function(err) {
				return (sketch_error(self, reject, err));
			});
		});
	}

	function generateQrCode(id, qrContent) {
		return new QRCode(id, {
			text: qrContent,
			width: 256,
			height: 256,
			colorDark: "#000000",
			colorLight: "#ffffff",
			correctLevel: QRCode.CorrectLevel.H,
		});
	}

	return {
		/**
		 * Compile the sketch and load it to the Z-Uno board
		 *
		 * @param {*} code Sketch source code (string)
		 * @param {*} hw Hardware vrevision (int, ex. 0x704)
		 * @param {*} freq Frequncy (string, ex. 'EU')
		 * @param {*} sec With security or not (boolean)
		 * @param {*} main_pow <ax power (int, without a special license the maximum is 50)
		 * @returns Returns a dictionary with smart_qr as string and dsk as string
		 */
		compile: function(code, hw, freq, sec, main_pow) {
			return sketch(code, hw, freq, sec, main_pow);
		},
	
		/**
		 * Draw the QR code of the board
		 *
		 * @param {*} id Id of the div tag that will host the QR-code image
		 * @param {*} qrContent Content of the QR-code to be printed
		 */
		drawQR: function(id, qrContent) {
			return generateQrCode(id, qrContent);
		},
		
		/**
		 * Set progress log callback
		 *
		 */
		setProgress: function(cbk) {
			progressCbk = cbk;
		}
		 
	};
}

/* Example

HTML:
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<div id="qr-code"></div>
<div id="dsk"></div>

JS:
var zcl = ZUnoCompiler();
async function compileAndLoad(code) {
	let res = zcl.compile(code, 0x704, "EU", true, 50);
	res.then(function(result) {
		let g_qcode = zcl.generateQrCode("qr-code", result["smart_qr"]);
		document.getElementById("dsk").innerHTML = result["dsk"];
		console.log(result);
	}, function(err) {
		console.error(err);
	});
}
*/
