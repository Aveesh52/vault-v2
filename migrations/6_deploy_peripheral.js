const fixed_addrs = require('./fixed_addrs.json');
const Migrations = artifacts.require("Migrations");
const Weth = artifacts.require("WETH9");
const Treasury = artifacts.require("Treasury");
const Controller = artifacts.require("Controller");
const EthProxy = artifacts.require("EthProxy");
const LimitPool = artifacts.require("LimitPool");
const DaiProxy = artifacts.require("DaiProxy");
const Vat  = artifacts.require("Vat");
const Pot = artifacts.require("Pot");
const ERC20 = artifacts.require("TestERC20");
const Pool = artifacts.require("Pool");
const YDai = artifacts.require("YDai");

module.exports = async (deployer, network, accounts) => {
  const migrations = await Migrations.deployed();

  let wethAddress;
  let treasuryAddress;
  let controllerAddress;
  let ethProxyAddress;

  let vatAddress;
  let potAddress;
  let daiAddress;

  if (network !== 'development') {
    wethAddress = fixed_addrs[network].wethAddress;
    vatAddress = fixed_addrs[network].vatAddress;
    potAddress = fixed_addrs[network].potAddress;
    daiAddress = fixed_addrs[network].daiAddress;
  } else {
      wethAddress = (await Weth.deployed()).address;
      vatAddress = (await Vat.deployed()).address;
      potAddress = (await Pot.deployed()).address;
      daiAddress = (await ERC20.deployed()).address;
  }

  const treasury = await Treasury.deployed();
  treasuryAddress = treasury.address;
  const controller = await Controller.deployed();
  controllerAddress = controller.address;

  // Setup EthProxy
  await deployer.deploy(
    EthProxy,
    wethAddress,
    treasuryAddress,
    controllerAddress,
  );
  ethProxyAddress = (await EthProxy.deployed()).address;
  await migrations.register(web3.utils.fromAscii('EthProxy'), ethProxyAddress);
  console.log('EthProxy', ethProxyAddress);

  // Setup LimitPool
  await deployer.deploy(LimitPool);
  limitPoolAddress = (await LimitPool.deployed()).address;
  await migrations.register(web3.utils.fromAscii('LimitPool'), limitPoolAddress);
  console.log('LimitPool', limitPoolAddress);

  // Setup Dai proxies for each series
  const yDaiNames = ['yDai0', 'yDai1', 'yDai2', 'yDai3'];
  const poolAddresses = []

  for (yDaiName of yDaiNames) {
    yDaiAddress = await migrations.contracts(web3.utils.fromAscii(yDaiName));
    yDai = await YDai.at(yDaiAddress);
    yDaiFullName = await yDai.name();
    poolAddress = await migrations.contracts(web3.utils.fromAscii( yDaiFullName + '-Pool') );
    poolAddresses.push(poolAddress)
  }
  await deployer.deploy(
    DaiProxy,
    daiAddress,
    controllerAddress,
    poolAddresses,
  );
  daiProxyAddress = (await DaiProxy.deployed()).address;

  await migrations.register(web3.utils.fromAscii('DaiProxy'), daiProxyAddress);
  console.log('DaiProxy', daiProxyAddress);
};