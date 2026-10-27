// Keywords -> synthesized activated abilities, triggers and replacements (expressed in Forge script syntax).
import { parseAbility } from './forge.js';
import { keywordExt } from './ext.js';

const cache = new Map();

function looksLikeFilter(s) { return !!s && (/\./.test(s) || /^(Creature|Card|Permanent|Artifact|Land)\b/.test(s)); }

function defFor(kw, face) {
  const parts = kw.split(':');
  const name = parts[0];
  let a = parts[1];
  const b = parts[2];
  // given by another card: "Encore:CardManaCost" (Wire Surgeons), "Encore:X:XAlternative$ Number$ConvertedManaCost"
  // (Sliver Gravemother): the card's own mana cost / mana value
  if (a === 'CardManaCost' || a === 'ManaCost') a = face.manaCostStr || '0';
  else if (a === 'X' && /XAlternative\$ Number\$ConvertedManaCost/.test(kw)) a = String(face.cmc || 0);
  const A = [], T = [], R = [], S = {};
  const etbSelf = 'Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self';
  const diesSelf = 'Mode$ ChangesZone | Origin$ Battlefield | Destination$ Graveyard | ValidCard$ Card.Self';
  switch (name) {
    case 'Equip': {
      const cost = a || '0';
      const valid = looksLikeFilter(b) ? 'Creature.YouCtrl+' + b.replace(/^Creature\.?/, '').replace(/^\+/, '').replace(/\./g, '+') : 'Creature.YouCtrl';
      A.push(`AB$ Attach | Cost$ ${cost} | ValidTgts$ ${valid.replace(/\+$/, '')} | TgtPrompt$ Select target creature you control | SorcerySpeed$ True | IsEquip$ True | AILogic$ Pump | SpellDescription$ Equip ${costText(cost)}`);
      break;
    }
    case 'Reconfigure':
      A.push(`AB$ Attach | Cost$ ${a} | ValidTgts$ Creature.YouCtrl+Other | TgtPrompt$ Select another target creature you control | SorcerySpeed$ True | IsEquip$ True | SpellDescription$ Reconfigure ${costText(a)} (attach)`);
      A.push(`AB$ Unattach | Cost$ ${a} | Defined$ Self | SorcerySpeed$ True | IsPresent$ Card.Self+Attached | SpellDescription$ Reconfigure ${costText(a)} (unattach)`);
      break;
    case 'Level up': A.push(`AB$ PutCounter | Cost$ ${a} | Defined$ Self | CounterType$ LEVEL | CounterNum$ 1 | SorcerySpeed$ True | SpellDescription$ Level up ${costText(a)}`); break;
    case 'Foretell': A.push(`AB$ Foretell | Cost$ 2 | ActivationZone$ Hand | PlayerTurn$ True | Static$ True | SpellDescription$ Foretell (pay {2}: exile this face down; cast it on a later turn for ${costText(parts.slice(1).join(':'))})`); break;
    case 'Suspend': {
      const n = a, cost = parts.slice(2).join(':');
      const instant = face.types && face.types.includes && face.types.includes('Instant');
      A.push(`AB$ Suspend | Cost$ ${cost} | ActivationZone$ Hand | Static$ True | SuspendTime$ ${n}${instant || face.keywords.includes('Flash') ? '' : ' | SorcerySpeed$ True'} | SpellDescription$ Suspend ${n} — ${costText(cost)}`);
      break;
    }
    case 'Class': {
      const level = +a;
      const rest = parts.slice(2).join(':');
      const costStr = rest.split(':')[0];
      const grant = rest.slice(costStr.length + 1);
      A.push(`AB$ ClassLevelUp | Cost$ ${costStr} | Defined$ Self | ClassLevel$ ${level} | SorcerySpeed$ True | IsPresent$ Card.Self+ClassLevelEQ${level - 1} | SpellDescription$ Level ${level} (${costText(costStr)})`);
      break;
    }
    case 'Dredge': break;
    case 'Cycling': A.push(`AB$ Draw | Cost$ ${a} Discard<1/CARDNAME> | ActivationZone$ Hand | NumCards$ 1 | IsCycling$ True | SpellDescription$ Cycling ${costText(a)}`); break;
    case 'TypeCycling': {
      const type = a === 'Basic' || a === 'Basic land' || a === 'BasicLand' ? 'Land.Basic' : a === 'Land' ? 'Land' : a;
      A.push(`AB$ ChangeZone | Cost$ ${b} Discard<1/CARDNAME> | ActivationZone$ Hand | Origin$ Library | Destination$ Hand | ChangeType$ ${type} | ChangeNum$ 1 | IsCycling$ True | SpellDescription$ ${a}cycling ${costText(b)}`);
      break;
    }
    case 'Crew': A.push(`AB$ Animate | Cost$ Crew<${a}> | Defined$ Self | Types$ Artifact,Creature | IsCrew$ True | SpellDescription$ Crew ${a}`); break;
    case 'Unearth': A.push(`AB$ ChangeZone | Cost$ ${a} | ActivationZone$ Graveyard | SorcerySpeed$ True | Origin$ Graveyard | Destination$ Battlefield | Defined$ Self | Unearth$ True | SpellDescription$ Unearth ${costText(a)}`); break;
    case 'Encore': A.push(`AB$ CopyPermanent | Cost$ ${a} ExileFromGrave<1/CARDNAME> | ActivationZone$ Graveyard | SorcerySpeed$ True | Defined$ Self | Encore$ True | SpellDescription$ Encore ${costText(a)}`); break;
    case 'Embalm': A.push(`AB$ CopyPermanent | Cost$ ${a} ExileFromGrave<1/CARDNAME> | ActivationZone$ Graveyard | SorcerySpeed$ True | Defined$ Self | AddTypes$ Zombie | SetColor$ White | NoManaCost$ True | SpellDescription$ Embalm ${costText(a)}`); break;
    case 'Eternalize': A.push(`AB$ CopyPermanent | Cost$ ${a} ExileFromGrave<1/CARDNAME> | ActivationZone$ Graveyard | SorcerySpeed$ True | Defined$ Self | AddTypes$ Zombie | SetColor$ Black | SetPower$ 4 | SetToughness$ 4 | NoManaCost$ True | SpellDescription$ Eternalize ${costText(a)}`); break;
    case 'Outlast': A.push(`AB$ PutCounter | Cost$ ${a} T | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1 | SorcerySpeed$ True | SpellDescription$ Outlast ${costText(a)}`); break;
    case 'Scavenge': A.push(`AB$ PutCounter | Cost$ ${a} ExileFromGrave<1/CARDNAME> | ActivationZone$ Graveyard | SorcerySpeed$ True | ValidTgts$ Creature | CounterType$ P1P1 | CounterNum$ KWScavX | SpellDescription$ Scavenge ${costText(a)}`); S.KWScavX = 'Count$CardPower'; break;
    case 'Transmute': A.push(`AB$ ChangeZone | Cost$ ${a} Discard<1/CARDNAME> | ActivationZone$ Hand | SorcerySpeed$ True | Origin$ Library | Destination$ Hand | ChangeType$ Card.cmcEQKWTransX | ChangeNum$ 1 | SpellDescription$ Transmute ${costText(a)}`); S.KWTransX = 'Count$CardManaCost'; break;
    // "Ninjutsu:U B:Commander" is commander ninjutsu (Yuriko): also from the command zone
    case 'Ninjutsu': A.push(b === 'Commander' ? `AB$ Ninjutsu | Cost$ ${a} | ActivationZone$ Hand,Command | SpellDescription$ Commander ninjutsu ${costText(a)}` : `AB$ Ninjutsu | Cost$ ${a} | ActivationZone$ Hand | SpellDescription$ Ninjutsu ${costText(a)}`); break;
    // commander ninjutsu also works from the command zone
    case 'CommanderNinjutsu': A.push(`AB$ Ninjutsu | Cost$ ${a} | ActivationZone$ Hand,Command | SpellDescription$ Commander ninjutsu ${costText(a)}`); break;
    case 'Prowess':
      T.push('Mode$ SpellCast | ValidCard$ Card.nonCreature | ValidActivatingPlayer$ You | TriggerZones$ Battlefield | Execute$ KWProwess | TriggerDescription$ Prowess (+1/+1 until end of turn)');
      S.KWProwess = 'DB$ Pump | Defined$ Self | NumAtt$ +1 | NumDef$ +1';
      break;
    case 'Undying':
      T.push(`${diesSelf}+counters_EQ0_P1P1 | Execute$ KWUndying | TriggerDescription$ Undying`);
      S.KWUndying = 'DB$ ChangeZone | Defined$ TriggeredNewCardLKICopy | Origin$ Graveyard | Destination$ Battlefield | WithCountersType$ P1P1';
      break;
    case 'Persist':
      T.push(`${diesSelf}+counters_EQ0_M1M1 | Execute$ KWPersist | TriggerDescription$ Persist`);
      S.KWPersist = 'DB$ ChangeZone | Defined$ TriggeredNewCardLKICopy | Origin$ Graveyard | Destination$ Battlefield | WithCountersType$ M1M1';
      break;
    case 'Afterlife':
      T.push(`${diesSelf} | Execute$ KWAfterlife | TriggerDescription$ Afterlife ${a}`);
      S.KWAfterlife = `DB$ Token | TokenAmount$ ${a || 1} | TokenScript$ wb_1_1_spirit_flying | TokenOwner$ You`;
      break;
    case 'Annihilator':
      T.push(`Mode$ Attacks | ValidCard$ Card.Self | Execute$ KWAnnihilator | TriggerDescription$ Annihilator ${a}`);
      S.KWAnnihilator = `DB$ Sacrifice | Defined$ TriggeredDefendingPlayer | SacValid$ Permanent | Amount$ ${a}`;
      break;
    case 'Exalted':
      T.push('Mode$ Attacks | ValidCard$ Creature.YouCtrl | Alone$ True | TriggerZones$ Battlefield | Execute$ KWExalted | TriggerDescription$ Exalted');
      S.KWExalted = 'DB$ Pump | Defined$ TriggeredAttackerLKICopy | NumAtt$ +1 | NumDef$ +1';
      break;
    case 'Extort':
      T.push('Mode$ SpellCast | ValidActivatingPlayer$ You | TriggerZones$ Battlefield | Execute$ KWExtort | TriggerDescription$ Extort');
      S.KWExtort = 'DB$ ExtortDrain | UnlessCost$ WB | UnlessPayer$ You | UnlessSwitched$ True | SpellDescription$ Extort: pay {W/B} to drain each opponent for 1';
      break;
    case 'Evolve':
      T.push('Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Creature.Other+YouCtrl | TriggerZones$ Battlefield | Evolve$ True | Execute$ KWEvolve | TriggerDescription$ Evolve');
      S.KWEvolve = 'DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1';
      break;
    case 'Living Weapon':
      T.push(`${etbSelf} | Execute$ KWGerm | TriggerDescription$ Living weapon`);
      S.KWGerm = 'DB$ Token | TokenScript$ b_0_0_phyrexian_germ | TokenOwner$ You | RememberTokens$ True | SubAbility$ KWGermAttach';
      S.KWGermAttach = 'DB$ Attach | Defined$ Remembered | SubAbility$ KWGermClean';
      S.KWGermClean = 'DB$ Cleanup | ClearRemembered$ True';
      break;
    case 'Job select':
      T.push(`${etbSelf} | Execute$ KWHero | TriggerDescription$ Job select`);
      S.KWHero = 'DB$ Token | TokenScript$ c_1_1_hero | TokenOwner$ You | RememberTokens$ True | SubAbility$ KWHeroAttach';
      S.KWHeroAttach = 'DB$ Attach | Defined$ Remembered | SubAbility$ KWHeroClean';
      S.KWHeroClean = 'DB$ Cleanup | ClearRemembered$ True';
      break;
    case 'Fabricate':
      T.push(`${etbSelf} | Execute$ KWFab | TriggerDescription$ Fabricate ${a}`);
      S.KWFab = 'DB$ GenericChoice | Choices$ KWFabC,KWFabS | AILogic$ Fabricate';
      S.KWFabC = `DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ ${a} | SpellDescription$ Put ${a} +1/+1 counter(s) on it`;
      S.KWFabS = `DB$ Token | TokenAmount$ ${a} | TokenScript$ c_1_1_a_servo | TokenOwner$ You | SpellDescription$ Create ${a} 1/1 Servo token(s)`;
      break;
    case 'Riot':
      T.push(`${etbSelf} | Execute$ KWRiot | TriggerDescription$ Riot`);
      S.KWRiot = 'DB$ GenericChoice | Choices$ KWRiotC,KWRiotH | AILogic$ Riot';
      S.KWRiotC = 'DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1 | SpellDescription$ +1/+1 counter';
      S.KWRiotH = 'DB$ Pump | Defined$ Self | KW$ Haste | Duration$ Permanent | SpellDescription$ Haste';
      break;
    case 'Mentor':
      T.push('Mode$ Attacks | ValidCard$ Card.Self | Execute$ KWMentor | TriggerDescription$ Mentor');
      S.KWMentor = 'DB$ PutCounter | ValidTgts$ Creature.attacking+powerLTKWMentorX | TgtPrompt$ Select target attacking creature with lesser power | CounterType$ P1P1 | CounterNum$ 1';
      S.KWMentorX = 'Count$CardPower';
      break;
    case 'Training':
      T.push('Mode$ Attacks | ValidCard$ Card.Self | IsPresent$ Creature.attacking+Other+powerGTKWTrainX | Execute$ KWTrain | TriggerDescription$ Training');
      S.KWTrain = 'DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1';
      S.KWTrainX = 'Count$CardPower';
      break;
    case 'Battle cry':
      T.push('Mode$ Attacks | ValidCard$ Card.Self | Execute$ KWBattleCry | TriggerDescription$ Battle cry');
      S.KWBattleCry = 'DB$ PumpAll | ValidCards$ Creature.attacking+Other | NumAtt$ +1';
      break;
    case 'Melee':
      T.push('Mode$ Attacks | ValidCard$ Card.Self | Execute$ KWMelee | TriggerDescription$ Melee');
      S.KWMelee = 'DB$ Pump | Defined$ Self | NumAtt$ +KWMeleeX | NumDef$ +KWMeleeX';
      S.KWMeleeX = 'Count$OpponentsAttacked';
      break;
    case 'Bushido':
      T.push(`Mode$ Blocks | ValidCard$ Card.Self | Execute$ KWBushido | TriggerDescription$ Bushido ${a}`);
      T.push(`Mode$ AttackerBlocked | ValidCard$ Card.Self | Execute$ KWBushido | TriggerDescription$ Bushido ${a}`);
      S.KWBushido = `DB$ Pump | Defined$ Self | NumAtt$ +${a} | NumDef$ +${a}`;
      break;
    case 'Afflict':
      T.push(`Mode$ AttackerBlocked | ValidCard$ Card.Self | Execute$ KWAfflict | TriggerDescription$ Afflict ${a}`);
      S.KWAfflict = `DB$ LoseLife | Defined$ TriggeredDefendingPlayer | LifeAmount$ ${a}`;
      break;
    case 'Myriad':
      T.push('Mode$ Attacks | ValidCard$ Card.Self | Execute$ KWMyriad | TriggerDescription$ Myriad');
      S.KWMyriad = 'DB$ Myriad';
      break;
    case 'Cascade':
      T.push('Mode$ SpellCast | ValidCard$ Card.Self | Execute$ KWCascade | TriggerDescription$ Cascade');
      S.KWCascade = 'DB$ Cascade';
      break;
    case 'Discover':
      T.push(`Mode$ SpellCast | ValidCard$ Card.Self | Execute$ KWDiscover | TriggerDescription$ Discover ${a}`);
      S.KWDiscover = `DB$ Discover | Num$ ${a}`;
      break;
    case 'Storm':
      T.push('Mode$ SpellCast | ValidCard$ Card.Self | Execute$ KWStorm | TriggerDescription$ Storm');
      S.KWStorm = 'DB$ CopySpellAbility | Defined$ TriggeredSpellAbility | Amount$ KWStormX | MayChooseTarget$ True';
      S.KWStormX = 'Count$StormCount';
      break;
    case 'Demonstrate':
      T.push('Mode$ SpellCast | ValidCard$ Card.Self | Execute$ KWDemo | OptionalDecider$ You | TriggerDescription$ Demonstrate');
      S.KWDemo = 'DB$ CopySpellAbility | Defined$ TriggeredSpellAbility | MayChooseTarget$ True';
      break;
    case 'Ward': {
      const cost = parts.slice(1).join(':');
      T.push('Mode$ BecomesTarget | ValidTarget$ Card.Self | ValidSource$ Card.OppCtrl,Emblem.OppCtrl | TriggerZones$ Battlefield | Execute$ KWWard | TriggerDescription$ Ward');
      S.KWWard = `DB$ Counter | Defined$ TriggeredSourceSA | UnlessCost$ ${cost} | UnlessPayer$ TriggeredSourceController`;
      break;
    }
    case 'Ravenous':
      T.push(`${etbSelf} | CheckSVar$ KWRavX | SVarCompare$ GE5 | Execute$ KWRavDraw | TriggerDescription$ Ravenous: draw a card`);
      S.KWRavX = 'Count$xPaid';
      S.KWRavDraw = 'DB$ Draw | NumCards$ 1';
      break;
    case 'Backup': {
      const n = a || 1;
      const grant = b && face.svars[b];
      T.push(`${etbSelf} | Execute$ KWBackup | TriggerDescription$ Backup ${n}`);
      S.KWBackup = `DB$ PutCounter | ValidTgts$ Creature | TgtPrompt$ Select target creature | CounterType$ P1P1 | CounterNum$ ${n}${grant ? ' | SubAbility$ KWBackupGrant' : ''}`;
      if (grant) S.KWBackupGrant = `${grant} | Defined$ ParentTarget | ConditionDefined$ ParentTarget | ConditionPresent$ Card.Other`;
      break;
    }
    case 'Squad':
      T.push(`${etbSelf} | CheckSVar$ KWSquadN | SVarCompare$ GE1 | Execute$ KWSquad | TriggerDescription$ Squad`);
      S.KWSquadN = 'Count$SquadCount';
      S.KWSquad = 'DB$ CopyPermanent | Defined$ Self | NumCopies$ KWSquadN';
      break;
    case 'Evoke':
      T.push(`${etbSelf} | CheckSVar$ KWEvoked | SVarCompare$ GE1 | Execute$ KWEvokeSac | TriggerDescription$ Evoke: sacrifice it`);
      S.KWEvoked = 'Count$Evoked';
      S.KWEvokeSac = 'DB$ Sacrifice | Defined$ Self';
      break;
    case 'Blitz':
      T.push(`${diesSelf} | CheckSVar$ KWBlitzed | SVarCompare$ GE1 | Execute$ KWBlitzDraw | TriggerDescription$ Blitz: draw a card`);
      S.KWBlitzed = 'Count$Blitzed';
      S.KWBlitzDraw = 'DB$ Draw | NumCards$ 1';
      break;
    case 'Echo':
      T.push('Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | CheckSVar$ KWEchoDue | SVarCompare$ GE1 | Execute$ KWEcho | TriggerDescription$ Echo');
      S.KWEchoDue = 'Count$EchoDue';
      S.KWEcho = `DB$ EchoUpkeep | EchoCost$ ${parts.slice(1).join(':')}`;
      break;
    case 'Hideaway':
      T.push(`${etbSelf} | Execute$ KWHideaway | TriggerDescription$ Hideaway ${a}`);
      S.KWHideaway = `DB$ Dig | DigNum$ ${a || 4} | ChangeNum$ 1 | DestinationZone$ Exile | ExileFaceDown$ True | ExiledWithSource$ True | RestRandomOrder$ True`;
      break;
    case 'Devour':
      T.push(`${etbSelf} | Execute$ KWDevour | TriggerDescription$ Devour ${a}`);
      S.KWDevour = `DB$ Devour | Amount$ ${a || 1}${b ? ' | DevourType$ ' + b : ''}`;
      break;
    case 'Exploit':
      T.push(`${etbSelf} | Execute$ KWExploit | TriggerDescription$ Exploit`);
      S.KWExploit = 'DB$ Sacrifice | SacValid$ Creature | Optional$ True | Exploit$ True';
      break;
    case 'Dethrone':
      T.push('Mode$ Attacks | ValidCard$ Card.Self | Attacked$ Player.withMostLife | Execute$ KWDethrone | TriggerDescription$ Dethrone');
      S.KWDethrone = 'DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1';
      break;
    case 'Renown':
      T.push(`Mode$ DamageDone | ValidSource$ Card.Self | ValidTarget$ Player | CombatDamage$ True | CheckSVar$ KWRenowned | SVarCompare$ EQ0 | Execute$ KWRenown | TriggerDescription$ Renown ${a}`);
      S.KWRenowned = 'Count$Renowned';
      S.KWRenown = `DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ ${a} | Renown$ True`;
      break;
    case 'Graft':
      T.push('Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Creature.Other | TriggerZones$ Battlefield | OptionalDecider$ You | IsPresent$ Card.Self+counters_GE1_P1P1 | Execute$ KWGraft | TriggerDescription$ Graft — you may move a +1/+1 counter from CARDNAME onto the entering creature');
      S.KWGraft = 'DB$ MoveCounter | Source$ Self | Defined$ TriggeredCard | CounterType$ P1P1 | CounterNum$ 1 | AILogic$ Graft';
      break;
    case 'Flanking':
      T.push('Mode$ AttackerBlockedByCreature | ValidCard$ Card.Self | ValidBlocker$ Creature.withoutFlanking | Execute$ KWFlanking | TriggerDescription$ Flanking (the blocking creature gets -1/-1 until end of turn)');
      S.KWFlanking = 'DB$ Pump | Defined$ TriggeredBlocker | NumAtt$ -1 | NumDef$ -1 | IsCurse$ True';
      break;
    case 'Station':
      A.push(`AB$ PutCounter | Cost$ tapXType<1/Creature.Other/another untapped creature you control> | Defined$ Self | CounterType$ CHARGE | CounterNum$ KWStationX | SorcerySpeed$ True | Station$ True | SpellDescription$ Station (tap another creature you control: put charge counters equal to its power on CARDNAME)`);
      S.KWStationX = 'Tapped$CardPower';
      break;
    case 'Vanishing':
      T.push('Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | IsPresent$ Card.Self+counters_GE1_TIME | Execute$ KWVanishRemove | TriggerDescription$ Vanishing — remove a time counter from CARDNAME');
      T.push('Mode$ CounterRemoved | ValidCard$ Card.Self | CounterType$ TIME | NewCounterAmount$ 0 | TriggerZones$ Battlefield | Execute$ KWVanishSac | TriggerDescription$ Vanishing — when the last time counter is removed, sacrifice CARDNAME');
      S.KWVanishRemove = 'DB$ RemoveCounter | Defined$ Self | CounterType$ TIME | CounterNum$ 1';
      S.KWVanishSac = 'DB$ Sacrifice | Defined$ Self';
      break;
    case 'For Mirrodin':
      T.push(`${etbSelf} | Execute$ KWRebel | TriggerDescription$ For Mirrodin! (create a 2/2 red Rebel creature token, then attach CARDNAME to it)`);
      S.KWRebel = 'DB$ Token | TokenScript$ r_2_2_rebel | TokenOwner$ You | RememberTokens$ True | SubAbility$ KWRebelAttach';
      S.KWRebelAttach = 'DB$ Attach | Defined$ Remembered | SubAbility$ KWRebelClean';
      S.KWRebelClean = 'DB$ Cleanup | ClearRemembered$ True';
      break;
    case 'Reinforce':
      A.push(`AB$ PutCounter | Cost$ ${b} Discard<1/CARDNAME> | ActivationZone$ Hand | ValidTgts$ Creature | TgtPrompt$ Select target creature | CounterType$ P1P1 | CounterNum$ ${a} | SpellDescription$ Reinforce ${a} — ${costText(b)} (discard this: put ${a} +1/+1 counters on target creature)`);
      break;
    case 'Plot':
      A.push(`AB$ Plot | Cost$ ${a} | ActivationZone$ Hand | SorcerySpeed$ True | Static$ True | SpellDescription$ Plot ${costText(a)} (exile it; cast it on a later turn as a sorcery without paying its mana cost)`);
      break;
    case 'Gravestorm':
      T.push('Mode$ SpellCast | ValidCard$ Card.Self | Execute$ KWGravestorm | TriggerDescription$ Gravestorm (copy this spell for each permanent put into a graveyard this turn)');
      S.KWGravestorm = 'DB$ CopySpellAbility | Defined$ TriggeredSpellAbility | Amount$ KWGravestormX | MayChooseTarget$ True';
      S.KWGravestormX = 'Count$ThisTurnEntered_Graveyard_from_Battlefield_Permanent';
      break;
    case 'Champion':
      T.push(`${etbSelf} | Execute$ KWChampion | TriggerDescription$ Champion ${a ? 'a ' + a : 'a creature'} (exile another one you control or sacrifice CARDNAME)`);
      T.push('Mode$ ChangesZone | Origin$ Battlefield | Destination$ Any | ValidCard$ Card.Self | Execute$ KWChampionBack | TriggerDescription$ Champion — the championed card returns to the battlefield');
      S.KWChampion = `DB$ Champion | ChampionType$ ${a || 'Creature'}`;
      S.KWChampionBack = 'DB$ ChangeZone | Defined$ Championed | Origin$ Exile | Destination$ Battlefield';
      break;
    case 'Cumulative upkeep':
      T.push(`Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ KWCumUpkeep | TriggerDescription$ Cumulative upkeep — ${parts[2] || costText(a)}`);
      S.KWCumUpkeep = `DB$ CumulativeUpkeep | UpkeepCost$ ${a}`;
      break;
    case 'Soulbond':
      T.push(`${etbSelf} | IsPresent$ Creature.YouCtrl+Other+unpaired | OptionalDecider$ You | Execute$ KWPairSelf | TriggerDescription$ Soulbond — you may pair CARDNAME with another unpaired creature you control`);
      T.push('Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Creature.YouCtrl+Other+unpaired | TriggerZones$ Battlefield | IsPresent$ Card.Self+unpaired | OptionalDecider$ You | Execute$ KWPairOther | TriggerDescription$ Soulbond — you may pair the entering creature with CARDNAME');
      S.KWPairSelf = 'DB$ Pair';
      S.KWPairOther = 'DB$ Pair | Defined$ TriggeredCard';
      break;
    case 'Fortify': {
      A.push(`AB$ Attach | Cost$ ${a} | ValidTgts$ Land.YouCtrl | TgtPrompt$ Select target land you control | SorcerySpeed$ True | IsEquip$ True | SpellDescription$ Fortify ${costText(a)}`);
      break;
    }
    case 'Impending':
      T.push('Mode$ Phase | Phase$ End of Turn | ValidPlayer$ You | TriggerZones$ Battlefield | IsPresent$ Card.Self+counters_GE1_TIME | Execute$ KWImpendRemove | TriggerDescription$ Impending — remove a time counter from CARDNAME');
      S.KWImpendRemove = 'DB$ RemoveCounter | Defined$ Self | CounterType$ TIME | CounterNum$ 1';
      break;
    case 'Mobilize':
      T.push(`Mode$ Attacks | ValidCard$ Card.Self | Execute$ KWMobilize | TriggerDescription$ Mobilize ${a} (create ${a} tapped and attacking 1/1 red Warrior tokens; sacrifice them at the next end step)`);
      S.KWMobilize = `DB$ Token | TokenAmount$ ${a || 1} | TokenScript$ r_1_1_warrior | TokenOwner$ You | TokenTapped$ True | TokenAttacking$ True | AtEOT$ Sacrifice`;
      break;
    case 'MayEffectFromOpeningHand': break;
    case 'Rebound': break;
    case 'Enlist': break;
    case 'Decayed':
      T.push('Mode$ Attacks | ValidCard$ Card.Self | Execute$ KWDecayed | TriggerDescription$ Decayed');
      S.KWDecayed = 'DB$ DelayedTrigger | Mode$ Phase | Phase$ EndCombat | Execute$ KWDecaySac | RememberObjects$ Self';
      S.KWDecaySac = 'DB$ Sacrifice | Defined$ DelayTriggerRemembered';
      break;
    case 'Gift':
      // permanents: "when it enters, [the promised opponent gets the gift]"; spells give it as they resolve
      if (['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].some(t => (face.types || []).includes(t))) {
        T.push(`${etbSelf}+PromisedGift | Execute$ KWGift | TriggerDescription$ Gift — the promised opponent gets the gift`);
        S.KWGift = 'DB$ GiveGift';
      }
      break;
    case 'Offspring':
      T.push(`${etbSelf} | CheckSVar$ KWOffN | SVarCompare$ GE1 | Execute$ KWOffspring | TriggerDescription$ Offspring`);
      S.KWOffN = 'Count$OffspringPaid';
      S.KWOffspring = 'DB$ CopyPermanent | Defined$ Self | SetPower$ 1 | SetToughness$ 1';
      break;
    default:
      // keywords defined by mechanics in their own modules (ext.js)
      if (!keywordExt[name]) return null;
      keywordExt[name]({ A, T, R, S, a, b, parts, face, kw });
  }
  return { A, T, R, S };
}

function costText(c) {
  if (!c) return '';
  return String(c).split(' ').map(t => /^[\dWUBRGCX]+$/.test(t) && t.length <= 2 ? `{${t}}` : t.replace(/<|>/g, ' ')).join('');
}

// Hidden keywords Forge stores as plain text keywords; turn some into statics.
export function synthesizeKeywords(game, card, ch) {
  if (!card || !ch) return;
  // a card off the battlefield can be looked at (and built) before a static gives it a keyword (Lier's flashback,
  // Rhet-Tomb Mystic's cycling): keywords added after that get their abilities then
  const from = Math.min(ch._synthN || 0, ch.keywords.length);
  if (ch._synth && from === ch.keywords.length) return;
  const first = !ch._synth;
  ch._synth = true;
  const face = card.faceDef;
  if (first && card.faceDown && card.zone === 'battlefield' && (card.disguised || card.cloaked) && !ch.keywords.includes('Ward:2')) ch.keywords.push('Ward:2');
  const fresh = ch.keywords.slice(first ? 0 : from);
  ch._synthN = ch.keywords.length;
  for (const kw of fresh) {
    let d = cache.get(kw + '|' + face.name);
    if (d === undefined) { d = defFor(kw, face); cache.set(kw + '|' + face.name, d); }
    if (!d) continue;
    const svars = Object.keys(d.S).length ? { ...ch.svars, ...d.S } : ch.svars;
    d.A.forEach((raw, i) => ch.abilities.push({ raw, parsed: parseAbility(raw), svars, src: card, key: `kw:${kw}:A${i}` }));
    d.T.forEach((raw, i) => ch.triggers.push({ raw, parsed: parseAbility(raw), svars, src: card, key: `kw:${kw}:T${i}` }));
    d.R.forEach((raw, i) => ch.replacements.push({ raw, parsed: parseAbility(raw), svars, src: card, key: `kw:${kw}:R${i}` }));
  }
  if (!first) return;
  // class levels: grant abilities of reached levels
  for (const kw of ch.keywords) {
    const m = kw.match(/^Class:(\d+):([^:]+):(.+)$/);
    if (!m) continue;
    if ((card.classLevel || 1) < +m[1]) continue;
    const g = m[3];
    let mm;
    for (const part of g.split('&')) {
      if ((mm = part.match(/^(AddTrigger|AddStaticAbility|AddAbility)\$ (.+)$/))) {
        const kind = mm[1] === 'AddTrigger' ? 'triggers' : mm[1] === 'AddStaticAbility' ? 'statics' : 'abilities';
        for (const n of mm[2].split(',').map(x => x.trim())) { const raw = ch.svars[n]; if (raw) ch[kind].push({ raw, parsed: parseAbility(raw), svars: ch.svars, src: card, key: `class${m[1]}:${n}` }); }
      }
    }
  }
  // face-down permanents can be turned face up for their morph / disguise cost
  if (card.faceDown && card.zone === 'battlefield') {
    for (const kw of card.def.faces[0].keywords) {
      const m = kw.match(/^(Morph|Megamorph|Disguise|Cloak):?(.*)$/);
      if (!m || !m[2]) continue;
      const raw = `AB$ SetState | Cost$ ${m[2]} | Defined$ Self | Mode$ TurnFaceUp | Static$ True | Megamorph$ ${m[1] === 'Megamorph'} | SpellDescription$ Turn face up (${m[1]} ${costText(m[2])})`;
      ch.abilities.push({ raw, parsed: parseAbility(raw), svars: card.def.faces[0].svars, src: card, key: 'morphUp' });
    }
    // a manifested or cloaked creature card can be turned face up for its mana cost
    const front = card.def.faces[0];
    if (card.manifested && front.types.includes('Creature') && front.manaCostStr) {
      const raw = `AB$ SetState | Cost$ ${front.manaCostStr} | Defined$ Self | Mode$ TurnFaceUp | Static$ True | SpellDescription$ Turn face up (mana cost ${costText(front.manaCostStr)})`;
      ch.abilities.push({ raw, parsed: parseAbility(raw), svars: front.svars, src: card, key: 'manifestUp' });
    }
  }
}

export function keywordInfo(kw) { return defFor(kw, { svars: {} }); }

export const SUPPORTED_KEYWORDS = new Set(['Flying', 'Equip', 'Trample', 'ETBReplacement', 'Enchant', 'Cycling', 'Vigilance', 'Flash', 'Haste', 'etbCounter', 'Deathtouch', 'Lifelink', 'Menace', 'First Strike', 'Flashback', 'Reach', 'TypeCycling', 'Indestructible', 'Changeling', 'Crew', 'Chapter', 'Defender', 'Kicker', 'Convoke', 'Ward', 'Double Strike', 'Cascade', 'Partner', 'Partner with', 'Evoke', 'Devoid', 'Multikicker', 'Unearth', 'Hexproof', 'Myriad', 'Ravenous', 'Landwalk', 'Fear', 'Intimidate', 'Shroud', 'Annihilator', 'Prowess', 'Persist', 'Undying', 'Exalted', 'Extort', 'Evolve', 'Living Weapon', 'Job select', 'Fabricate', 'Riot', 'Mentor', 'Training', 'Battle cry', 'Melee', 'Bushido', 'Afflict', 'Storm', 'Demonstrate', 'Backup', 'Squad', 'Blitz', 'Dash', 'Echo', 'Hideaway', 'Devour', 'Exploit', 'Dethrone', 'Renown', 'Toxic', 'Infect', 'Wither', 'Affinity', 'Delve', 'Improvise', 'Escape', 'Retrace', 'Overload', 'Split second', 'Umbra armor', 'Totem armor', 'Morph', 'Megamorph', 'Disguise', 'Encore', 'Embalm', 'Eternalize', 'Outlast', 'Scavenge', 'Transmute', 'Ninjutsu', 'CommanderNinjutsu', 'Decayed', 'Offspring', 'Afterlife', 'Squad', 'Protection', 'Shadow', 'Horsemanship', 'Skulk', 'Jump-start', 'Discover', 'Rebound', 'Choose a Background', 'Friends forever', 'Doctor\'s companion', 'Ascend', 'Reconfigure', 'Level up', 'Foretell', 'Suspend', 'Class', 'Madness', 'Miracle', 'Aftermath', 'Undaunted', 'Spectacle', 'Surge', 'Bargain', 'Mutate', 'Bestow', 'Strive', 'Escalate', 'Fuse',
  'Graft', 'Flanking', 'Sunburst', 'Mayhem', 'All creatures able to block CARDNAME do so.', 'Gift', 'Casualty', 'Replicate', 'AlternateAdditionalCost', 'Emerge', 'Prowl', 'Entwine', 'MayFlashCost', 'Tiered', 'Spree', 'Dredge', 'Cipher', 'Cloak', 'Station', 'Vanishing', 'For Mirrodin', 'Reinforce', 'Plot', 'Gravestorm', 'Champion', 'Cumulative upkeep', 'Bloodthirst', 'Read ahead', 'Harmonize', 'Offering', 'Buyback', 'You may choose not to untap CARDNAME during your untap step.', 'Soulbond', 'Daybound', 'Nightbound', 'Awaken', 'Space sculptor', 'As an additional cost to cast creature spells, you may pay any amount of mana. If you do, that creature enters with that many additional +1/+1 counters on it.', 'Enlist', 'Fortify', 'Disturb', 'Companion', 'MayEffectFromOpeningHand', 'Unleash', 'Compleated', 'Impending', 'Mobilize', 'Start your engines', 'MayFlashSac',
  'Prevent all combat damage that would be dealt to and dealt by CARDNAME.', 'Prevent all combat damage that would be dealt to CARDNAME.', 'Prevent all damage that would be dealt to CARDNAME.', 'Prevent all combat damage that would be dealt by CARDNAME.', 'Prevent all damage that would be dealt to and dealt by CARDNAME.']);
// casting (mech-casting.js): alternative and additional costs, casting from other zones
for (const k of ['Warp', 'Sneak', 'Web-slinging', 'Freerunning', 'Teamwork', 'More Than Meets the Eye', 'Living metal', 'Splice', 'Prototype', 'Craft', 'Assist', 'Conspire', 'Ripple', 'Epic', 'Amplify', 'Tribute', 'Recover', 'Paradigm', 'Transfigure', 'Spend only colored mana on X. No more than one mana of each color may be spent this way.']) SUPPORTED_KEYWORDS.add(k);
