(function(Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        alert('This extension must be run unsandboxed in TurboWarp!');
    }

    let device = null;
    let characteristic = null;
    let protocolVersion = 1; // 1 for legacy (SPRK+, 2.0), 2 for modern (BOLT, Mini, RVR)
    let sequenceNum = 0;

    let collisionOccurred = false;
    let isCharging = false;
    let currentHeading = 0;
    let currentSpeed = 0;

    // UUIDs for both legacy and modern Sphero generations
    const LEGACY_SERVICE = '22bb746f-bb00-2754-be41-02657003413c';
    const LEGACY_CHAR    = '22bb746f-bb02-2754-be41-02657003413c';

    const MODERN_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    const MODERN_TX_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

    class SpheroUniversalExtension {
        getInfo() {
            return {
                id: 'spherouniversal',
                name: 'Sphero Universal',
                color1: '#00AEEF',
                color2: '#0082B2',
                blocks: [
                    {
                        opcode: 'connect',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'connect to any Sphero robot'
                    },
                    {
                        opcode: 'isConnected',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'is Sphero connected?'
                    },

                    '---',

                    // Hat Blocks
                    {
                        opcode: 'whenCollision',
                        blockType: Scratch.BlockType.HAT,
                        text: 'when Sphero collides'
                    },
                    {
                        opcode: 'whenCharging',
                        blockType: Scratch.BlockType.HAT,
                        text: 'when Sphero on charger'
                    },

                    '---',

                    // Movement
                    {
                        opcode: 'roll',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'roll speed [SPEED] heading [HEADING]',
                        arguments: {
                            SPEED: { type: Scratch.ArgumentType.NUMBER, defaultValue: 50 },
                            HEADING: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
                        }
                    },
                    {
                        opcode: 'stop',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'stop Sphero'
                    },
                    {
                        opcode: 'setHeading',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'set current heading as 0° (aim)'
                    },

                    '---',

                    // LEDs
                    {
                        opcode: 'setRGB',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'set LED color r: [R] g: [G] b: [B]',
                        arguments: {
                            R: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
                            G: { type: Scratch.ArgumentType.NUMBER, defaultValue: 255 },
                            B: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
                        }
                    },
                    {
                        opcode: 'setBackLed',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'set back tail LED brightness [BRIGHTNESS]',
                        arguments: {
                            BRIGHTNESS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 255 }
                        }
                    },

                    '---',

                    // Reporters
                    {
                        opcode: 'getSpeed',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'current speed'
                    },
                    {
                        opcode: 'getHeading',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'current heading'
                    },
                    {
                        opcode: 'isOnCharger',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'is on charger?'
                    }
                ]
            };
        }

        async connect() {
            try {
                // Broad name prefix filters covering almost all Sphero product lines
                device = await navigator.bluetooth.requestDevice({
                    filters: [
                        { namePrefix: 'SK-' }, // SPRK+ / BOLT
                        { namePrefix: 'SB-' }, // BOLT
                        { namePrefix: 'SM-' }, // Mini
                        { namePrefix: 'RO-' }, // Ollie / Darkside
                        { namePrefix: 'BP-' }, // BB-8 / R2-D2
                        { namePrefix: 'Sphero' }
                    ],
                    optionalServices: [LEGACY_SERVICE, MODERN_SERVICE]
                });

                const server = await device.gatt.connect();

                // Attempt Legacy Connection first (SPRK+, 2.0, BB-8, Ollie)
                try {
                    const service = await server.getPrimaryService(LEGACY_SERVICE);
                    characteristic = await service.getCharacteristic(LEGACY_CHAR);
                    protocolVersion = 1;

                    await characteristic.startNotifications();
                    characteristic.addEventListener('characteristicvaluechanged', this.handleLegacyNotifications.bind(this));
                    
                    // Enable collision detection
                    await this.sendPacket(0x02, 0x12, [0x01, 60, 60, 60, 60, 10]);
                    console.log('Connected via Legacy Sphero Protocol');
                } catch (e) {
                    // Fall back to Modern Connection (BOLT, Mini, RVR)
                    const service = await server.getPrimaryService(MODERN_SERVICE);
                    characteristic = await service.getCharacteristic(MODERN_TX_CHAR);
                    protocolVersion = 2;
                    console.log('Connected via Modern Sphero API v2 Protocol');
                }

                // Initial success indicator color (Green)
                await this.setRGB({ R: 0, G: 255, B: 0 });
            } catch (err) {
                console.error('Universal Sphero connection error:', err);
            }
        }

        isConnected() {
            return characteristic !== null && device && device.gatt.connected;
        }

        handleLegacyNotifications(event) {
            const value = event.target.value;
            if (!value || value.byteLength < 5) return;
            const packet = new Uint8Array(value.buffer);
            if (packet[0] === 0xFF && packet[1] === 0xFE) {
                const idCode = packet[2];
                if (idCode === 0x07) {
                    collisionOccurred = true;
                    setTimeout(() => { collisionOccurred = false; }, 100);
                }
                if (idCode === 0x01) {
                    const state = packet[5];
                    isCharging = (state === 0x01 || state === 0x02);
                }
            }
        }

        whenCollision() {
            if (collisionOccurred) {
                collisionOccurred = false;
                return true;
            }
            return false;
        }

        whenCharging() {
            return isCharging;
        }

        async sendPacket(did, cid, data = []) {
            if (!characteristic) return;

            if (protocolVersion === 1) {
                // --- Legacy Protocol V1 Packaging ---
                sequenceNum = (sequenceNum + 1) & 0xFF;
                const sop1 = 0xFF;
                const sop2 = 0xFE;
                const dlen = data.length + 1;

                const packetHeader = [sop1, sop2, did, cid, sequenceNum, dlen];
                const packetBody = [...packetHeader.slice(2), ...data];

                let sum = 0;
                for (let i = 0; i < packetBody.length; i++) {
                    sum += packetBody[i];
                }
                const chk = (~(sum % 256)) & 0xFF;
                const fullPacket = new Uint8Array([...packetHeader, ...data, chk]);

                await characteristic.writeValue(fullPacket);
            } else {
                // --- Modern Protocol V2 Packaging ---
                const sof = 0x8d;
                const seq = 0x00;
                const flags = 0x0E;

                const body = [did, cid, seq, ...data];
                let sum = 0;
                for (let i = 0; i < body.length; i++) {
                    sum += body[i];
                }
                const checksum = ~(sum & 0xFF) & 0xFF;
                const packet = new Uint8Array([sof, flags, ...body, checksum, 0xd8]);

                await characteristic.writeValue(packet);
            }
        }

        async roll(args) {
            const speed = Math.min(Math.max(parseInt(args.SPEED) || 0, 0), 255);
            let heading = parseInt(args.HEADING) || 0;
            heading = (heading % 360 + 360) % 360;

            currentSpeed = speed;
            currentHeading = heading;

            const hMsb = (heading >> 8) & 0xFF;
            const hLsb = heading & 0xFF;

            // DID 0x02 (Sphero), CID 0x30 (Roll) works across both generations
            await this.sendPacket(0x02, 0x30, [speed, hMsb, hLsb, 1]);
        }

        async stop() {
            currentSpeed = 0;
            await this.roll({ SPEED: 0, HEADING: currentHeading });
        }

        async setHeading() {
            await this.sendPacket(0x02, 0x01, [0x00, 0x00]);
            currentHeading = 0;
        }

        async setRGB(args) {
            const r = Math.min(Math.max(parseInt(args.R) || 0, 0), 255);
            const g = Math.min(Math.max(parseInt(args.G) || 0, 0), 255);
            const b = Math.min(Math.max(parseInt(args.B) || 0, 0), 255);

            // DID 0x02, CID 0x20 (RGB LED)
            await this.sendPacket(0x02, 0x20, [r, g, b, 0x00]);
        }

        async setBackLed(args) {
            const brightness = Math.min(Math.max(parseInt(args.BRIGHTNESS) || 0, 0), 255);
            // DID 0x02, CID 0x21 (Back LED)
            await this.sendPacket(0x02, 0x21, [brightness]);
        }

        getSpeed() { return currentSpeed; }
        getHeading() { return currentHeading; }
        isOnCharger() { return isCharging; }
    }

    Scratch.extensions.register(new SpheroUniversalExtension());
})(Scratch);
