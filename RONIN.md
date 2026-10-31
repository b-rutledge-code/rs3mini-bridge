# DJI Ronin app

Wire behavior of `com.dji.ronin` 2.1.2 (version code 6936).

## BLE scan

`BluetoothLeScanner` runs a low-latency scan, callback `ALL_MATCHES`, with no service-UUID filter. Each window is about 10 seconds, then about 2 seconds of pause. That window matches `BleConstants.DEFAULT_SCAN_TIMEOUT`. With no gimbal in range the RS 3 Mini page shows **DJI Device Not Found** and status **Searching...**.

## Link

The classes under `dji.midware.ble2` do the link:

1. `BleManager` calls `BleScanner.startScan`. The known-device path logs `ConnectKnown onStartScan`, `onScanning` with the last address, and `onScanFinished`.
2. `BleConnector` logs `start connect`, then `MSG_TIMEOUT`. A failed connect retries with `MSG_RETRY_CONNECT`. `onConnectionStateChange` calls `discoverServices`.
3. `onServicesDiscovered` follows. `enableNotification` calls `setCharacteristicNotification`, then `writeDescriptor`. A failed write retries with `MSG_RETRY_WRITE`. `onDescriptorWrite` and `onCharacteristicWrite` log the GATT status.
4. `BleDataTransmitter` sends the bytes. The failure log is `send data while BluetoothGatt is null`.
5. `dji.logic.Handheld.DJIBlePingHeart` sends `sendBleHeartPack` and `sendBleHeartPackForFocus` while `needBleHeart` is set. `stopBleHeartPack` ends that.
6. `setHighSpeedMode` is a connector method.

## GATT roles

`dji.midware.ble2.BleConstants` stores the four UUID strings as static field initializers. Field order in the class is `UUID_CHAR_NOTIFY`, `UUID_CHAR_WRITE`, `UUID_DESCRIPTOR_READ`, `UUID_SERVICE`.

| Field | UUID |
| --- | --- |
| `UUID_SERVICE` | `0000FFF0-0000-1000-8000-00805F9B34FB` |
| `UUID_CHAR_NOTIFY` | `0000FFF4-0000-1000-8000-00805F9B34FB` |
| `UUID_CHAR_WRITE` | `0000FFF5-0000-1000-8000-00805F9B34FB` |
| `UUID_DESCRIPTOR_READ` | `00002902-0000-1000-8000-00805f9b34fb` |

`2902` is the client characteristic configuration descriptor. The app writes `FFF5` and subscribes to `FFF4` by writing that descriptor.

The same array sets `DEFAULT_CONNECT_TIMEOUT` to 10, `DEFAULT_SCAN_TIMEOUT` to 10, and `DEFAULT_TIMEOUT` to 5000. `BleConnector` keeps the write handle in `mWriteCharacteristic`.

## Gimbal command bytes

`dji.midware.data.config.P3.CmdSet` is an enum whose `value()` method returns the `data` field. `GIMBAL` is `0x04`. `DJICmdSetBase.<init>` inserts every command id from `getCurCmdIdValues()` into a `SparseArray` keyed by `CmdIdInterface.value()`.

`CmdIdGimbal.getCurCmdIdValues()` returns `CmdIdGimbal.CmdIdType.values()`. Each constant's `value()` is the command byte.

| Command | `value()` |
| --- | --- |
| `Control` | `0x01` |
| `GetPushParams` | `0x05` |
| `RollFinetune` | `0x07` |
| `AutoCalibration` | `0x08` |
| `SetAngle` | `0x0a` |
| `AngleControl` | `0x0a` |
| `SpeedControl` | `0x0c` |
| `SetOnOrOff` | `0x0d` |
| `SetUserParams` | `0x0f` |
| `GetUserParams` | `0x10` |
| `SaveUserParams` | `0x11` |
| `SubscribeGimbalParams` | `0x12` |
| `ResetUserParams` | `0x13` |
| `AbsAngleControl` | `0x14` |
| `GetPushType` | `0x1c` |
| `GetPushUserParams` | `0x24` |
| `SetDelayTimelapseParams` | `0x25` |
| `GetPushAbnormalStatus` | `0x27` |
| `GetPushTutorialStatus` | `0x2b` |
| `SetTutorialStep` | `0x2c` |
| `FocusControl` | `0x2f` |
| `GetPushSensorCalibrationStatus` | `0x30` |
| `RoninSetParams` | `0x31` |
| `RoninGetParams` | `0x32` |
| `RobinPushBattery` | `0x33` |
| `SetHandleParams` | `0x35` |
| `GetHandleParams` | `0x36` |
| `SetTimelapseParams` | `0x37` |
| `GetPushTimelapseStatus` | `0x38` |
| `BalanceAdjust` | `0x40` |
| `ResetAndSetMode` | `0x4c` |
| `NotiFyCameraId` | `0x56` |
| `GetPushHandheldStickState` | `0x57` |
| `SetHandheldStickControlEnabled` | `0x58` |
| `SetTrack` | `0x62` |
| `SetPanorama` | `0x63` |
| `GetPushPanorama` | `0x64` |
| `SetPushPeripheralStatus` | `0x66` |
| `GetPushExternalDeviceData` | `0x69` |
| `SetCalibration` | `0x6a` |
| `GetPushTrackAndTimelapse` | `0x6b` |
| `GetPushCalibration` | `0x6e` |
| `Other` | `0x1ff` |

## Track path (`0x62`)

`DataGimbalSetTrackStatus.addRoadPoint(FFFFF)` takes **move, stop, yaw, pitch, roll** and stores a midware `RoadPoint(yaw, pitch, roll, move, stop)`.

`doPack` writes `[flags, count]` then each point as five **int16 LE** values: **moveTime, stopTime, roll, pitch, yaw** (app floats × 10). Header bits: bit1 `isTripod`, bit2 `startOrStop`, bit3 `recordOrPreview`. When `startOrStop == 1`, only the flags byte is sent.

`CreateTrackView.onPointAdd(FFF)` builds `CreateTrackView$RoadPoint(p1, p2, moveTime, stopTime)` — **p3 unused**. `BaseRoadPoint(FF)` assigns **yaw=p1, pitch=p2**. `sendToDeviceStart` calls `addRoadPoint(moveTime, stopTime, yaw, pitch, 0)` (roll forced to 0).

## Stick write

`DataGimbalControl` is the stick packet. Its constructor stores `SOURCE.APP_JOYSTICK`. The instance fields are `yaw`, `pitch`, `roll`, `mode`, `source`, and `isReset`.

`DataGimbalControl.MODE.value()`:

| Mode | `value()` |
| --- | --- |
| `YawNoFollow` | `0x00` |
| `FPV` | `0x01` |
| `YawFollow` | `0x02` |
| `OTHER` | `0xfe` |

`DataGimbalControl.SOURCE.value()`:

| Source | `value()` |
| --- | --- |
| `RESERVED` | `0x00` |
| `REAL_JOYSTICK` | `0x01` |
| `APP_JOYSTICK` | `0x02` |
| `MOTION` | `0x03` |
| `GAMEPAD` | `0x04` |

`DataGimbalControl.start()` builds a `SendPack` and calls `DataBase.start`. The body sets:

| `SendPack` field | Value |
| --- | --- |
| `senderType` | `DeviceType.APP` = `0x02` |
| `receiverType` | `DeviceType.GIMBAL` = `0x04` |
| `cmdType` | `CMDTYPE.REQUEST` = `0x00` |
| `isNeedAck` | `NEEDACK.YES` = `0x02` |
| `encryptType` | `EncryptType.NO` = `0x00` |
| `cmdSet` | `CmdSet.GIMBAL` = `0x04` |
| `cmdId` | `CmdIdGimbal.CmdIdType.Control` = `0x01` |

`DataBase.start` calls `preprocessPack`, which calls `getSendData`. `getSendData` calls `doPack` and returns `_sendData`. `doPack` allocates a 9-byte array and fills it with `BytesUtil.getUnsignedBytes`, which returns the low 16 bits little-endian (low byte, then high byte). The copy lengths are 2, 2, 2, 1, and 1.

| Offset | Contents |
| --- | --- |
| 0–1 | `pitch`, little-endian |
| 2–3 | `roll`, little-endian |
| 4–5 | `yaw`, little-endian |
| 6 | low 8 bits of `(mode.value() << 6) \| (isReset ? 1 : 0) << 5` |
| 7 | `0x00` |
| 8 | `source.value()` |

A new stick packet uses `APP_JOYSTICK` (`0x02`) at offset 8. `YawNoFollow`, `FPV`, and `YawFollow` land in byte 6 as `0x00`, `0x40`, and `0x80`, with `0x20` added when `isReset` is set. `OTHER` (`0xfe`) shifts to the same low byte as `YawFollow`.

`preprocessPack` stores that array in `SendPack.data`, then `SendPack.doPack` writes `buffer`. `Pack.<init>` sets `sof` to `0x55` and `version` to `1`. `senderId` stays `0` on this path. `DataBase.<init>` stores `receiverID` as `-1`, and nothing in the BLE path overwrites it, so `preprocessPack` skips the copy and `receiverId` stays `0`. A `seq` of `0` is replaced by `PackUtil.getSeq()`. `length` is `13 + payload length`, so the stick packet is 22 bytes.

| Offset | Contents |
| --- | --- |
| 0 | `sof` = `0x55` |
| 1 | low 8 bits of `length` |
| 2 | `(version << 2) \| (length >> 8)` |
| 3 | CRC-8 of bytes 0–2 |
| 4 | `(senderId << 5) \| senderType` |
| 5 | `(receiverId << 5) \| receiverType` |
| 6–7 | `seq`, little-endian |
| 8 | `(cmdType << 7) \| (isNeedAck << 5) \| encryptType` |
| 9 | `cmdSet` |
| 10 | `cmdId` |
| 11–19 | the 9-byte stick payload |
| 20–21 | CRC-16 of the first `length - 2` bytes, little-endian |

With the defaults above, byte 4 is `0x02`, byte 5 is `0x04` when `receiverId` is `0`, byte 8 is `0x40`, byte 9 is `0x04`, and byte 10 is `0x01`. `length` 22 puts `0x16` in byte 1 and `0x04` in byte 2.

Both checksums are in `libGroudStation.so`, registered as `native_calcCrc8` and `native_calcCrc16`. CRC-8 is reflected polynomial `0x8c`, initial value `0x77`, no final xor: `crc = table[(crc ^ byte) & 0xff]`. CRC-16 is reflected polynomial `0x8408`, initial value `0x3692`, no final xor: `crc = table[(crc ^ byte) & 0xff] ^ (crc >> 8)`. The tables are `DjiCrc8Table` and `DjiCrc16Table`. `DataBase.start` passes the pack to `submitTask`.

## Stick numbers

The setters store the int they are given. `RoninJoystickView.controlHandheldDevice` computes it. `mSize / 2` is the half-width of the control. `660f` is `0x44250000` and `1024f` is `0x44800000`.

| Axis | Value |
| --- | --- |
| pitch | `(int) (-mCenterY * 660f / (mSize / 2) + 1024f)` |
| yaw | `(int) (mCenterX * 660f / (mSize / 2) + 1024f)` |
| roll | `1024` |

Center is `1024`. Full deflection is `660` counts either side, so the int runs from `364` to `1684`. If `abs(center) * 2 / mSize` is below `0.1f` (`0x3dcccccd`), that axis is forced back to `1024`. The method then sets mode `YawNoFollow` and calls `start`. The reverse stick negates the opposite axes and sends roll as `-1024`. The roll bar, motion view, and gamepad use the same `660` and `1024`. Motion and gamepad apply them to a `-1..1` axis and skip the view-size divide.

## Sequence

`PackUtil.getSeq` is synchronized on the class. Static `seq` starts at `0`. Each call adds `1` and returns the stored value. The first call returns `1`. The value `0x55` is skipped, because that byte is the frame sof: after incrementing to `0x55` the method adds `1` again and returns `0x56`. At `0xFFFF` it stores `0` and returns `0`. There is no other mask.

## Heart

`DJIBlePingHeart.sendBleHeartPack` schedules `DataCommonPushHeart` at a fixed rate, initial delay `0`, period `1000` ms. `doPack` writes one payload byte, `0x00`. `start` fills the same `SendPack` frame with:

| Field | Value |
| --- | --- |
| sender | `DeviceType.APP` = `0x02` |
| cmdType | `CMDTYPE.ACK` = `0x01` |
| isNeedAck | `NEEDACK.NO` = `0x00` |
| encryptType | `EncryptType.NO` = `0x00` |
| cmdSet | `CmdSet.COMMON` = `0x00` |
| cmdId | `CmdIdCommon.HeartBeat` = `0x0e` |
| repeatTimes | `1` |

`length` is `14`. The receiver type and receiver id are the arguments passed into `sendBleHeartPack`. The focus heart is a different packet, `DataFocusPingHeart`, command id `PingConnect` (`0x00`), not this one-byte heart.

## Notify

`BleConnector.onCharacteristicChanged` passes the characteristic value to `BleDataReceiveListener.onDataReceived` with no UUID compare. `BluetoothService` hands the bytes to `DJIPackManager.parse`. The parser waits for `13` bytes, finds sof `0x55`, checks CRC-8 on the 4-byte head, and takes the frame length from the little-endian short at offset 1 masked with `0x3FF`. `RecvPack.setBuffer` then splits every frame the same way the writer built it:

| Offset | Field |
| --- | --- |
| 0 | sof |
| 1–2 | version = short >> 10, length = short & `0x3FF` |
| 3 | crc8 |
| 4 | senderId = byte >> 5, senderType = byte & 31 |
| 5 | receiverId = byte >> 5, receiverType = byte & 31 |
| 6–7 | seq |
| 8 | cmdType = byte >> 7, isNeedAck = (byte >> 5) & 3, encryptType = byte & 7 |
| 9 | cmdSet |
| 10 | cmdId |
| 11 | payload, or a ccode byte when cmdType is `1` and a ccode is required, in which case the payload starts at 12 |

The last two bytes are CRC-16. Command set `0x04` and command id `0x01` are only the bytes at offsets 9 and 10. There is no separate stick-ack parser.

## How the 22 bytes are written

`submitTask` queues the pack. `BluetoothService.sendBuffer` slices `SendPack.buffer` by `BleConnector.mMaxDataLength`. The connector constructor stores `20`. After a successful MTU callback the field becomes `mtu - 3`. At the initial `20`, the 22-byte stick frame leaves as a 20-byte write and a 2-byte write. `BleConnector.sendData` checks the chunk against that limit, calls `mWriteCharacteristic.setValue`, then `BluetoothGatt.writeCharacteristic` with the characteristic as the only argument. `initWriteCharcteristic` has already called `setWriteType(1)`, which is `WRITE_TYPE_NO_RESPONSE`, on the characteristic it looked up with `UUID_CHAR_WRITE`. The stick `start` call passes the ack flag as false, so the timeout retry is not armed. The frame byte still says an ack is wanted.

## Sleep

`DataGimbalGetPushAbnormalStatus.getSleepMode` reads one byte of `_recData` at offset 4 and keeps bit 0. The command id is `GetPushAbnormalStatus` (`0x27`). Bit 0 set means the gimbal is asleep. The same push carries the other abnormal-status flags (`isGimbalLocked`, `isMotorProtected`, per-axis lock) at their own offsets.
