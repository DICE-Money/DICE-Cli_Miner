/* 
 * Copyright (c) 2017, Mihail Maldzhanski
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

//Includes
const modFs = require('fs');
const modDICECalculator = require('../../models/DICECalculator/DICECalculator.js');
const modDICEUnit = require('../../models/DICECalculator/DICEUnit.js');
const modDICEPrototype = require('../../models/DICECalculator/DICEPrototype.js');
const modDigAddress = require('../../models/AddressCalculator/DigitalAdressCalculator_ECDH.js');
const modDNSBinder = require('../../models/DNSBinder/DNSBinder.js');
const modTCPWorker = require('../../models/TCP_IP/TcpWorker.js');
const modDICEValue = require('../../models/DICEValue/DICEValue.js');
const modEnc = require('../../models/Encryptor/Encryptor_Signer.js');
const modBase58 = require('../../models/Base58/Base58.js');
const modVIEW = require('../../models/VIEW_Console/VIEW_Console.js');
const modCommandParser = require('../../models/CommandParser/CommandParser.js');
const modControllers = require('./Controllers/controllers.js');

//Configuration
const exConfig = require('./config/minerConfig.js');

//Create instances of the following models
var DICE = new modDICEUnit();
var DICEProto = new modDICEPrototype();
var DiceCalculatorL = new modDICECalculator("js");
var DNS = new modDNSBinder();
var AddressGen = new modDigAddress();
var TCPClient = new modTCPWorker();
var DICEValue = new modDICEValue(DiceCalculatorL);
var Time = new Date();
var Bs58 = new modBase58();
var CommandParser = new modCommandParser(process.argv, exConfig.minerArgs);


//Local static Data`
var isRequestTransmitted = false;
var currentState = CommandParser.getState();
var keyPair = {};
var scheduler_10ms = undefined;
var zeroes = undefined;
var encryptor = undefined;
var view_console = new modVIEW(exConfig.minerVIEW_IF.tableCodes, exConfig.minerVIEW_IF.tablePorts, exConfig.minerViewOut);
view_console.setAllowed(exConfig.minerViewCfg);
var isCudaReq = false;
var securityCounter = 0;
var isTcpReady = false;
var isDnsHttpRequested = false;

//Check Addresses
var appArgs = JSON.parse(modControllers.checkConfig);

const commandFunctions =
        {
            "funcUpdateDns": funcUpdateDns,
            "funcCalculate": funcCalculate,
            'funcValidate': funcValidate,
            'funcKeyGen': funcKeyGen,
            'funcTradeOwnerless': funcTradeOwnerless,
            'funcTradeCurrent': funcTradeCurrent,
            'funcTradeNew': funcTradeNew,
            'funcCalculateCUDA': funcCalculateCUDA,
            'funcRegister': funcRegister,
            'funcVersion': funcVersion,
            'funcHelp': funcHelp,
            'ERROR': funcERROR
        };

//#############################################################################
// Local functions
//#############################################################################
function funcCalculate() {
    //Start scheduled program
    scheduler_10ms = setInterval(main10ms, 10);
    currentState = exConfig.minerStates.eStep_InitTCPConnection;

    function main10ms() {
        switch (currentState) {
            case exConfig.minerStates.eStep_InitTCPConnection:
                //Get Data from input file
                getKeyPair();

                //Convert HexDash to BS58
                getAddrOperator();

                //Init connection
                dnsInitialization();

                currentState = exConfig.minerStates.eStep_DnsBinderWait;
                break;

            case exConfig.minerStates.eStep_DnsBinderWait:
                if (isTcpReady) {
                    continueInitconnection();
                    currentState = exConfig.minerStates.eStep_ExchangeCertificates;
                }
                break;

            case exConfig.minerStates.eStep_ExchangeCertificates:
                executeExchangeCertificate(exConfig.minerStates.eStep_RequestZeroes);
                break;

            case exConfig.minerStates.eStep_RequestZeroes:
                zeroes = requestToServer(keyPair.digitalAddress,
                        () => TCPClient.Request("GET Zeroes", keyPair.digitalAddress),
                        () => currentState = exConfig.minerStates.eStep_CalculateDICE);
                break;

            case exConfig.minerStates.eStep_CalculateDICE:
                requestToServer(keyPair.digitalAddress,
                        (addr) => TCPClient.Request("GET Validation", addr),
                        (receivedData) => {
                    receivedData = JSON.parse(receivedData);
                    //Calculate needed zeroes
                    if (appArgs.specificUnitValue !== undefined) {
                        view_console.printCode("USER_INFO", "UsInf0051", appArgs.specificUnitValue);
                        zeroes = DICEValue.getZeroesFromN(appArgs.specificUnitValue, receivedData.N);
                    }

                    calculateDICE(appArgs);
                    currentState = exConfig.minerStates.eStep_RequestValidation;
                });
                break;

            case exConfig.minerStates.eStep_RequestValidation:
                requestToServer(keyPair.digitalAddress,
                        (addr) => TCPClient.Request("GET Validation", addr),
                        (receivedData) => {
                    receivedData = JSON.parse(receivedData);
                    DICEValue.setDICEProtoFromUnit(DICE);
                    DICEValue.calculateValue(receivedData.k, receivedData.N);
                    view_console.printCode("USER_INFO", "UsInf0052", (DICEValue.unitValue * 1024 + "/1024"));
                    currentState = (DICEValue.unitValue === "InvalidDICE" ? exConfig.minerStates.eStep_RequestZeroes : exConfig.minerStates.eStep_SendPrototype);
                });
                break;

            case exConfig.minerStates.eStep_SendPrototype:
                requestToServer(keyPair.digitalAddress,
                        (addr) => {
                    saveDICEToFile(appArgs.fileOutput);
                    var encryptedData = encryptor.encryptDataPublicKey(DICEValue.getDICEProto().toBS58(), Buffer.from(Bs58.decode(appArgs.addrOp)));
                    TCPClient.Request("SET Prototype", addr, encryptedData);
                },
                        (response) => {
                    printServerReturnData(response);
                    currentState = exConfig.minerStates.eStep_SHAOfUnit;
                });
                break;

            case exConfig.minerStates.eStep_SHAOfUnit:
                hashOfUnit();
                currentState = exConfig.minerStates.eExit_FromApp;
                break;

            case exConfig.minerStates.eExit_FromApp:
                funcExit();
                break;

            default:
                throw "Application has Improper state !";
        }
    }
}

function funcValidate() {

    //Print data inside Encoded DICE Unit
    printDiceUnitFromBS58();

    //Start scheduled program
    scheduler_10ms = setInterval(main10ms, 10);
    currentState = exConfig.minerStates.eStep_InitTCPConnection;

    function main10ms() {
        switch (currentState) {
            case exConfig.minerStates.eStep_InitTCPConnection:
                //Get Data from input file
                getKeyPair();

                //Get operator address from Dice Unit
                getAddrOperatorFromDICEUnit();

                //Init connection
                dnsInitialization();

                currentState = exConfig.minerStates.eStep_DnsBinderWait;
                break;

            case exConfig.minerStates.eStep_DnsBinderWait:
                if (isTcpReady) {
                    continueInitconnection();
                    currentState = exConfig.minerStates.eStep_ExchangeCertificates;
                }
                break;

            case exConfig.minerStates.eStep_ExchangeCertificates:
                executeExchangeCertificate(exConfig.minerStates.eStep_RequestValidation);
                break;

            case exConfig.minerStates.eStep_RequestValidation:
                requestToServer(keyPair.digitalAddress,
                        (addr) => TCPClient.Request("GET Validation", addr),
                        (receivedData) => {
                    receivedData = JSON.parse(receivedData);
                    DICEValue.setDICEProtoFromUnit(DICE);
                    DICEValue.calculateValue(receivedData.k, receivedData.N);
                    view_console.printCode("USER_INFO", "UsInf0052", (DICEValue.unitValue * 1024 + "/1024"));
                    currentState = exConfig.minerStates.eStep_SHAOfUnit;
                });
                break;

            case exConfig.minerStates.eStep_SHAOfUnit:
                hashOfUnit();
                currentState = exConfig.minerStates.eExit_FromApp;
                break;

            case exConfig.minerStates.eExit_FromApp:
                funcExit();
                break;

            default:
                throw "Application has Improper state !";
        }
    }
}

function funcKeyGen() {
    view_console.printCode("USER_INFO", "UsInf0053");
    saveKeyPair();
}

function funcTradeOwnerless() {
    //Start scheduled program
    scheduler_10ms = setInterval(main10ms, 10);
    currentState = exConfig.minerStates.eStep_CurrentReleaseOwnerless;

    function main10ms() {
        switch (currentState) {
            case exConfig.minerStates.eStep_CurrentReleaseOwnerless:

                // Read File to DICE Unit
                var file = modFs.readFileSync(appArgs.diceUnit, "utf8");
                DICE = DICE.fromBS58(file);

                //Get key and address
                getKeyPair();

                //Get Address from Unit
                getAddrOperatorFromDICEUnit();

                //Init Connections
                dnsInitialization();

                currentState = exConfig.minerStates.eStep_DnsBinderWait;
                break;

            case exConfig.minerStates.eStep_DnsBinderWait:
                if (isTcpReady) {
                    continueInitconnection();
                    currentState = exConfig.minerStates.eStep_ExchangeCertificates;
                }
                break;

            case exConfig.minerStates.eStep_ExchangeCertificates:
                executeExchangeCertificate(exConfig.minerStates.eStep_CurrentReleaseOwnerlessToServer);
                break;

            case exConfig.minerStates.eStep_CurrentReleaseOwnerlessToServer:
                requestToServer(keyPair.digitalAddress,
                        (addr) => {
                    var claimData = {};
                    //Set DICE Unit to Dice validatior
                    DICEValue.setDICEProtoFromUnit(DICE);

                    claimData["diceProto"] = DICEValue.getDICEProto().toBS58();
                    var encryptedData = encryptor.encryptDataPublicKey(JSON.stringify(claimData), Buffer.from(Bs58.decode(appArgs.addrOp)));
                    TCPClient.Request("SET CurrentReleaseOwnerless", addr, encryptedData);
                },
                        (response) => {
                    printServerReturnData(response);
                    currentState = exConfig.minerStates.eExit_FromApp;
                });
                break;

            case exConfig.minerStates.eExit_FromApp:
                funcExit();
                break;

            default:
                throw "Application has Improper state !";
        }
    }
}

function funcTradeCurrent() {
    //Start scheduled program
    scheduler_10ms = setInterval(main10ms, 10);
    currentState = exConfig.minerStates.eStep_CurrentOwnerTrade;

    function main10ms() {
        switch (currentState) {
            case exConfig.minerStates.eStep_CurrentOwnerTrade:
                var file = modFs.readFileSync(appArgs.diceUnit, "utf8");
                DICE = DICE.fromBS58(file);
                getAddrOperatorFromDICEUnit();
                dnsInitialization();
                curOwnerTrade();
                currentState = exConfig.minerStates.eStep_DnsBinderWait;
                break;

            case exConfig.minerStates.eStep_DnsBinderWait:
                if (isTcpReady) {
                    continueInitconnection();
                    currentState = exConfig.minerStates.eStep_ExchangeCertificates;
                }
                break;

            case exConfig.minerStates.eStep_ExchangeCertificates:
                executeExchangeCertificate(exConfig.minerStates.eStep_CurrentOwnerClaimToServer);
                break;

            case exConfig.minerStates.eStep_CurrentOwnerClaimToServer:
                requestToServer(keyPair.digitalAddress,
                        (addr) => {
                    DICEValue.setDICEProtoFromUnit(DICE);
                    var claimData = {};
                    claimData["newOwner"] = AddressGen.convertHexDashToBS58(appArgs.addrMin);
                    claimData["diceProto"] = DICEValue.getDICEProto().toBS58();
                    var encryptedData = encryptor.encryptDataPublicKey(JSON.stringify(claimData), Buffer.from(Bs58.decode(appArgs.addrOp)));
                    TCPClient.Request("SET CurrentOwnerClaim", addr, encryptedData);
                },
                        (response) => {
                    printServerReturnData(response);
                    currentState = exConfig.minerStates.eExit_FromApp;
                });
                break;

            case exConfig.minerStates.eExit_FromApp:
                funcExit();
                break;

            default:
                throw "Application has Improper state !";
        }
    }
}

function funcTradeNew() {
    //Start scheduled program
    scheduler_10ms = setInterval(main10ms, 10);
    currentState = exConfig.minerStates.eStep_NewOwnerTrade;

    function main10ms() {
        switch (currentState) {
            case exConfig.minerStates.eStep_NewOwnerTrade:
                try {
                    newOwnerTrade();
                } catch (e) {
                    // Try as normal DICE
                    // Read File to DICE Unit
                    var file = modFs.readFileSync(appArgs.diceUnit, "utf8");
                    DICE = DICE.fromBS58(file);

                    //Get key and address
                    getKeyPair();
                }
                getAddrOperatorFromDICEUnit();
                dnsInitialization();
                currentState = exConfig.minerStates.eStep_DnsBinderWait;
                break;

            case exConfig.minerStates.eStep_DnsBinderWait:
                if (isTcpReady) {
                    continueInitconnection();
                    currentState = exConfig.minerStates.eStep_ExchangeCertificates;
                }
                break;

            case exConfig.minerStates.eStep_ExchangeCertificates:
                executeExchangeCertificate(exConfig.minerStates.eStep_NewOwnerClaimToServer);
                break;


            case exConfig.minerStates.eStep_NewOwnerClaimToServer:
                requestToServer(keyPair.digitalAddress,
                        (addr) => {
                    DICEValue.setDICEProtoFromUnit(DICE);
                    var claimData = {};
                    claimData["newOwner"] = keyPair.digitalAddress;
                    claimData["diceProto"] = DICEValue.getDICEProto().toBS58();
                    var encryptedData = encryptor.encryptDataPublicKey(JSON.stringify(claimData), Buffer.from(Bs58.decode(appArgs.addrOp)));
                    TCPClient.Request("SET NewOwnerClaim", addr, encryptedData);
                },
                        (response) => {
                    printServerReturnData(response);
                    saveDICEToFile(appArgs.diceUnit + exConfig.minerExtensions.unit);
                    currentState = exConfig.minerStates.eExit_FromApp;
                });
                break;

            case exConfig.minerStates.eExit_FromApp:
                funcExit();
                break;

            default:
                throw "Application has Improper state !";
        }
    }
}

function funcCalculateCUDA() {
    isCudaReq = true;
    funcCalculate();
}

function funcRegister() {

    //Get KeyPair
    getKeyPair();

    //Read DICE Unit from FS
    var DiceFile = modFs.readFileSync(appArgs.diceUnit, "utf8");

    //Logic for application is to trade an already mined unit which is stored in FS
    DICE = DICE.fromBS58(DiceFile);

    //Get Address from Unit
    getAddrOperatorFromDICEUnit();

    //Init connection
    dnsInitialization();

    //Start scheduled program
    scheduler_10ms = setInterval(main10ms, 10);
    currentState = exConfig.minerStates.eStep_DnsBinderWait;

    function main10ms() {
        switch (currentState) {

            case exConfig.minerStates.eStep_DnsBinderWait:
                if (isTcpReady) {
                    continueInitconnection();
                    currentState = exConfig.minerStates.eStep_ExchangeCertificates;
                }
                break;

            case exConfig.minerStates.eStep_ExchangeCertificates:
                executeExchangeCertificate(exConfig.minerStates.eStep_RequestValidation);
                break;

            case exConfig.minerStates.eStep_RequestValidation:
                requestToServer(keyPair.digitalAddress,
                        (addr) => TCPClient.Request("GET Validation", addr),
                        (receivedData) => {
                    receivedData = JSON.parse(receivedData);
                    DICEValue.setDICEProtoFromUnit(DICE);
                    DICEValue.calculateValue(receivedData.k, receivedData.N);
                    view_console.printCode("USER_INFO", "UsInf0052", (DICEValue.unitValue * 1024 + "/1024"));
                    currentState = (DICEValue.unitValue === "InvalidDICE" ? exConfig.minerStates.eExit_FromApp : exConfig.minerStates.eStep_SendPrototype);
                });
                break;

            case exConfig.minerStates.eStep_SendPrototype:
                requestToServer(keyPair.digitalAddress,
                        (addr) => {
                    var encryptedData = encryptor.encryptDataPublicKey(DICEValue.getDICEProto().toBS58(), Buffer.from(Bs58.decode(appArgs.addrOp)));
                    TCPClient.Request("SET Prototype", addr, encryptedData);
                },
                        (response) => {
                    printServerReturnData(response);
                    currentState = exConfig.minerStates.eStep_SHAOfUnit;
                });
                break;

            case exConfig.minerStates.eStep_SHAOfUnit:
                hashOfUnit();
                currentState = exConfig.minerStates.eExit_FromApp;
                break;

            case exConfig.minerStates.eExit_FromApp:
                funcExit();
                break;

            default:
                throw "Application has Improper state !";
        }
    }
}

function funcUpdateDns() {
    //Delete file
    modFs.unlink(exConfig.minerDnsFile.path, () => {    
        //Download
        dnsInitialization(funcExit);
        view_console.printCode("USER_INFO", "UsInf0089");
    });
}

function funcHelp() {
    var text = CommandParser.getHelpString(exConfig.minerCommandTable);
    view_console.print("\n" + exConfig.minerVersion + "\n");
    view_console.print(text);
}

function funcVersion() {
    view_console.print(exConfig.minerVersion);
}

function funcExit() {
    try {
        //If Connection was established
        TCPClient.close();

        //stop Shcheduler
        clearInterval(scheduler_10ms);
    } catch (e) {
        //NoThing
    }

    //Exit From Application
    view_console.printCode("USER_INFO", "UsInf0054");

    //Terminate the process
    process.exit();
}

function funcERROR() {
    view_console.printCode("ERROR", "Err0005");
    funcExit();
}

//#############################################################################
// Local logic of Application
//#############################################################################

//Get function name which must to me executed
var funcName = CommandParser.getExecFuncByTable(exConfig.minerCommandTable);

//Execute function 
try {
    commandFunctions[funcName]();
} catch (e) {

}

//#############################################################################
// Local Help function
//#############################################################################

//General Use Function to work properly with server
function requestToServer(addrMiner, activate, deactivate) {
    var receivedData;
    if (false === isRequestTransmitted) {
        activate(addrMiner);
        isRequestTransmitted = true;
    } else {
        receivedData = TCPClient.readByAddress(addrMiner);
        if (receivedData !== undefined) {
            isReady = true;
            isRequestTransmitted = false;
            try {
                receivedData = encryptor.decryptDataPublicKey(receivedData, Buffer.from(Bs58.decode(appArgs.addrOp)));
            } catch (e) {
                //Nothing
                //Do not decrypt the data
                //Exit from the application
                view_console.printCode("ERROR", "Err0006");
                funcExit();
            }
            deactivate(receivedData);
        }
    }
    return receivedData;
}

function exchangeCertificates(addrMiner, activate, deactivate) {
    var receivedData;
    if (false === isRequestTransmitted) {
        activate(addrMiner);
        isRequestTransmitted = true;
    } else {
        receivedData = TCPClient.readByAddress(addrMiner);
        if (receivedData !== undefined) {
            isRequestTransmitted = false;
            deactivate(receivedData);
        }
    }
    return receivedData;
}

function executeExchangeCertificate(nextState) {
    exchangeCertificates(keyPair.digitalAddress,
            () => {
        var certificate = encryptor.getKeyExchangeCertificate(Buffer.from(Bs58.decode(appArgs.addrOp)));
        TCPClient.Request("SET Certificate", keyPair.digitalAddress, certificate);
    }, (cert) => {
        try {
            var valid = encryptor.acceptKeyExchangeCertificate(cert, Buffer.from(Bs58.decode(appArgs.addrOp)));
            if (valid !== undefined) {
                if (typeof valid === "string") {
                    currentState = nextState;
                } else {
                    view_console.printCode("ERROR", "Err0007");
                }
            }
        } catch (e) {
            if (exConfig.minerSecurityLevels.length > securityCounter) {
                //Update security level
                encryptor.setSecurityLevel(exConfig.minerSecurityLevels[securityCounter]);
                securityCounter++;
            } else {
                //Exit
                view_console.printCode("ERROR", "Err0007", e);
                currentState = exConfig.minerStates.eExit_FromApp;
            }
        }
    });
}

//Function Generate DICE unit (Contains busy loop)
function calculateDICE(Args) {
    //Inform for generetion
    view_console.printCode("USER_INFO", "UsInf0056", zeroes);
    var elapsedTime = 0;
    var addrOpL = Bs58.decode(Args.addrOp).toString('hex');
    var addrMinL = Bs58.decode(keyPair.digitalAddress).toString('hex');

    //Start measuring
    Time = Date.now();

    //Generating new DICE Unit  
    if (true === isCudaReq) {
        DICE = DiceCalculatorL.getValidDICE_CUDA(addrOpL, addrMinL, zeroes, exConfig.minerPathToCuda, `cudaJsUnit_${keyPair.digitalAddress}.json`);
    } else {
        DICE = DiceCalculatorL.getValidDICE(Args.addrOp, keyPair.digitalAddress, zeroes);
    }
    //Stop measuring
    elapsedTime = Date.now() - Time;

    view_console.printCode("USER_INFO", "UsInf0065", elapsedTime);
}

//Save to File 
function saveDICEToFile(fileOutput) {
    var fileIncrementor = 0;
    var testFile = fileOutput;

    while (modFs.existsSync(testFile)) {
        testFile = fileOutput + "." + fileIncrementor;
        fileIncrementor++;
    }

    //Save new name of file
    fileOutput = testFile;

    //Inform for saving
    view_console.printCode("USER_INFO", "UsInf0057", fileOutput);

    //Write to File
    modFs.writeFileSync(fileOutput+exConfig.minerExtensions.unit, DICE.toBS58());

    //Write to File
    //modFs.writeFileSync(fileOutput + ".json", JSON.stringify(DICE.toHexStringifyUnit()), 'utf8');
}

//Calculate Hash
function hashOfUnit() {
    view_console.printCode("USER_INFO", "UsInf0071", DiceCalculatorL.getSHA3OfUnit(DICE));
}

//Init TCP Connection
function dnsInitialization(callback) {
    //Initialize DNS
    if (modFs.existsSync(exConfig.minerDnsFile.path) && isDnsHttpRequested === false) {
        DNS.initializeDB(exConfig.minerDnsFile.path, exConfig.minerDnsFile.type);
        isTcpReady = true;
    } else {
        if (!isDnsHttpRequested) {
            DNS.getGoogleDriveData(exConfig.minerHttpDns, () => {
                isTcpReady = true;
                if (callback !== undefined) {
                    callback();
                }
            });
            isDnsHttpRequested = true;
        }
    }
}

function continueInitconnection() {
    //Set Tcp to ready
    isTcpReady = true;

    //Requst DNS Binder to get IP and PORT
    var serverData;
    try {
        serverData = DNS.lookup(AddressGen.convertBS58ToHexDash(appArgs.addrOp));
    } catch (e) {
        serverData = DNS.lookup(AddressGen.convertHexToHexDash(appArgs.addrOp));
    }

    try {
        //Create connection
        TCPClient.create("client", serverData.ip, serverData.port, () => {
            view_console.printCode("ERROR", "Err0001");
            currentState = exConfig.minerStates.eExit_FromApp;
        }, view_console);
    } catch (e) {
        view_console.printCode("ERROR", "Err0008", e);
        funcExit();
    }
}

//Read key pair from file
function getKeyPair() {
    if (undefined !== appArgs.keyPair) {
        var file = modFs.readFileSync(appArgs.keyPair, "utf8");
        keyPair = JSON.parse(file);
        keyPair = AddressGen.fromHexDash(keyPair);
        encryptor = new modEnc({private: Bs58.decode(keyPair.privateKey), public: Bs58.decode(keyPair.digitalAddress)}, exConfig.minerSecurityLevels[securityCounter]);
    } else {
        //Nothing
    }
}

//Write key pair from file
function saveKeyPair() {
    if (undefined !== appArgs.fileOutput) {
        //Calculate new pair
        AddressGen.CalculateKeyAdressPair();

        //Save to local var
        keyPair.privateKey = AddressGen.getPrivateKey('bs58');
        keyPair.digitalAddress = AddressGen.getDigitalAdress('hexDash');

        //Print newly generated pair
        view_console.printCode("USER_INFO", "UsInf0059", keyPair.privateKey);
        view_console.printCode("USER_INFO", "UsInf0060", keyPair.digitalAddress);

        //Print newly generated pair
        view_console.printCode("DEV_INFO", "DevInf0111", AddressGen.getPrivateKey('hex'));
        view_console.printCode("DEV_INFO", "DevInf0112", AddressGen.getDigitalAdress('hex'));

        //Save to file
        modFs.writeFileSync(appArgs.fileOutput+exConfig.minerExtensions.key, JSON.stringify(keyPair), 'utf8');
    } else {
        //Nothing
    }
}

//Validating DICE Unit from file in Base 58 encoding
function printDiceUnitFromBS58() {
    var file = modFs.readFileSync(appArgs.diceUnit, "utf8");

    //Read DICE Unit from file
    try {
        DICE = DICE.from(file);
    } catch (e) {
        DICE = DICE.fromBS58(file);
    }
    Buffer.from(DICE.payLoad.buffer).toString('hex');

    view_console.printCode("USER_INFO", "UsInf0061");
    view_console.printCode("USER_INFO", "UsInf0062", Buffer.from(DICE.addrOperator.buffer).toString('hex'));
    view_console.printCode("USER_INFO", "UsInf0063", Buffer.from(DICE.addrMiner.buffer).toString('hex'));
    view_console.printCode("USER_INFO", "UsInf0064", Buffer.from(DICE.validZeros.buffer).toString('hex'));
    view_console.printCode("USER_INFO", "UsInf0065", Buffer.from(DICE.swatchTime.buffer).toString('hex'));
    view_console.printCode("USER_INFO", "UsInf0066", Buffer.from(DICE.payLoad.buffer).toString('hex'));

}

//Miner 1 sends unit to new owner
function curOwnerTrade() {

    //Get KeyPair
    getKeyPair();

    //Read DICE Unit from FS
    var DiceFile = modFs.readFileSync(appArgs.diceUnit, "utf8");

    //Logic for application is to trade an already mined unit which is stored in FS
    DICE = DICE.fromBS58(DiceFile);

    //Encrypt unit which is in BS58 with new owner address
    var encData = encryptor.encryptFilePublicKey(DICE.toBS58(), Buffer.from(Bs58.decode(AddressGen.convertHexDashToBS58(appArgs.addrMin))));

    //Hash of Unit
    var hashOfUnit = DiceCalculatorL.getSHA3OfUnit(DICE);

    //Preapare data for storing
    var fsData = {};
    fsData['addr'] = keyPair.digitalAddress;
    fsData['unit'] = encData;

    //Save to file
    modFs.writeFileSync(appArgs.fileOutput+exConfig.minerExtensions.unitEnc, Bs58.encode(Buffer.from(JSON.stringify(fsData))), 'utf8');
    return hashOfUnit;
}

//Miner 2 receives
function newOwnerTrade() {

    //Get KeyPair
    getKeyPair();

    //Read DICE Unit from FS
    var DiceFileJSON = modFs.readFileSync(appArgs.diceUnit, "utf8");

    //Parse file from object
    var DiceFile = JSON.parse(Bs58.decode(DiceFileJSON));

    //Encrypt Hash with new owner address
    var decoded = encryptor.decryptFilePublicKey(DiceFile.unit, Buffer.from(Bs58.decode(DiceFile.addr)));

    //Logic for application is to trade an already mined unit which is stored in FS
    DICE = DICE.fromBS58(decoded.toString());

    //Hash of Unit
    var hashOfUnit = DiceCalculatorL.getSHA3OfUnit(DICE);

    return hashOfUnit;
}

function printServerReturnData(data) {
    var response = JSON.parse(data);

    //Print data
    view_console.printCode("USER_INFO", "UsInf0067");
    view_console.printCode("USER_INFO", "UsInf0068", response.status.toString());
    view_console.printCode("USER_INFO", "UsInf0069", response.data.curOwner);
    view_console.printCode("USER_INFO", "UsInf0070", response.data.diceValue);
    view_console.printCode("USER_INFO", "UsInf0071", response.data.hash);
    view_console.printCode("USER_INFO", "UsInf0072");
}

function getAddrOperatorFromDICEUnit() {
    if (appArgs.diceUnit !== undefined) {
        appArgs.addrOp = Bs58.encode(Buffer.from(DICE.addrOperator, "hex")).toString();
    }
}

function getAddrOperator() {
    if (appArgs.addrOp !== undefined) {
        appArgs.addrOp = AddressGen.convertHexDashToBS58(appArgs.addrOp);
    }
}
