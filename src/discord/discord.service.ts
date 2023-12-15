import { Injectable } from '@nestjs/common';
import * as Discord from 'discord.js';
import { token, serverId, channelIds } from '../../config.json';
import * as dayjs from 'dayjs';
import * as duration from 'dayjs/plugin/duration';
import 'dayjs/plugin/timezone';
import 'dayjs/plugin/utc';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LogEntry, LogEntrySchema } from './schema/log-entry.schema';
import { LogLeave, LogLeaveSchema } from './schema/log-leave.schema';
import { UserTotalTime, UserTotalTimeSchema } from './schema/user-total-tiem.schema';
import { checkDevice } from './components/devices/get-device';
import { VoiceEvent, VoiceEventSchema } from './schema/event-in-voice-chat.schema';

dayjs.extend(duration);
dayjs.extend(require('dayjs/plugin/timezone'));
dayjs.extend(require('dayjs/plugin/utc'));

@Injectable()
export class DiscordService {
  private readonly client: Discord.Client;
  private userTimeMap: Map<string, { joinTime: string }> = new Map();
  private totalTimes: Map<string, number> = new Map();

  constructor( 
    @InjectModel(LogEntry.name) private readonly logEntryModel: Model<LogEntry>,
    @InjectModel(LogLeave.name) private readonly logLeaveModel: Model<LogLeave>,
    @InjectModel(UserTotalTime.name) private readonly userTotalTimeModel: Model<UserTotalTime>,
    @InjectModel(VoiceEvent.name) private readonly voiceEventModel: Model<UserTotalTime>
    
  ) {
    this.client = new Discord.Client({
      intents: [
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.DirectMessages,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildVoiceStates,
        Discord.GatewayIntentBits.GuildPresences,
      ],
      partials: [
        Discord.Partials.Message,
        Discord.Partials.Channel,
        Discord.Partials.GuildMember,
        Discord.Partials.User,
        Discord.Partials.GuildScheduledEvent,
        Discord.Partials.ThreadMember,
      ],
    });

    this.client.once('ready', (client) => {
      console.log('Bot ' + client.user.tag + ' is now online!');
    });

    this.client.login(token);

    this.setupEventHandlers();
    
  }
  
  private async setupEventHandlers() {
    this.client.on('voiceStateUpdate', async (oldState, newState) => {
      try {
        const guild = await newState.guild.members.fetch(newState.member.user.id);
        const updatedState = {
          ...newState,
          member: guild,
        };

        if (
          updatedState.channelId &&
          updatedState.guild.id === serverId &&
          updatedState.channelId === channelIds.voiceChannel
        ) {
          if (!this.userTimeMap.has(updatedState.member.id)) {
            const entry = {
              username: updatedState.member.user.username,
              userId: updatedState.member.id,
              action: 'join',
              timestamp: dayjs().tz('Asia/Bangkok').format(),
            };

            await this.logEntry(updatedState, entry);
            this.userTimeMap.set(updatedState.member.id, { joinTime: entry.timestamp });
          }

          if (oldState.selfDeaf !== newState.selfDeaf && newState.channelId === channelIds.voiceChannel) {
            await this.logUserEvent(newState.member.id, newState.member.user.username, newState.selfDeaf ? 'Deaf' : 'Undeaf');
          }
  
          if (oldState.selfMute !== newState.selfMute && newState.channelId === channelIds.voiceChannel) {
            await this.logUserEvent(newState.member.id, newState.member.user.username, newState.selfMute ? 'Mute' : 'Unmute');
          }
  
          if (oldState.streaming !== newState.streaming && newState.channelId === channelIds.voiceChannel) {
            await this.logUserEvent(newState.member.id, newState.member.user.username, newState.streaming ? 'Start Streaming' : 'Stop Streaming');
          }
  
          if (oldState.selfVideo !== newState.selfVideo && newState.channelId === channelIds.voiceChannel) {
            await this.logUserEvent(newState.member.id, newState.member.user.username, newState.selfVideo ? 'Start Sharing Video' : 'Stop Sharing Video');
          }
  
          if (oldState.deaf !== newState.deaf && newState.channelId === channelIds.voiceChannel) {
            await this.logUserEvent(newState.member.id, newState.member.user.username, newState.deaf ? 'Server Deaf' : 'Server Undeaf');
          }

          
        } else if (oldState.channelId === channelIds.voiceChannel && !newState.channelId) {
          const entry = {
            username: oldState.member.user.username,
            userId: oldState.member.id,
            action: 'leave',
            timestamp: dayjs().tz('Asia/Bangkok').format(),
          };

          await this.logLeave(oldState, entry);
        }

      } catch (error) {
        console.error('Error handling voiceStateUpdate event:', error);
      }
    });
  }

  private async handleUserTotalTime(oldState, entry) {
    try {
      if (this.userTimeMap.has(entry.userId)) {
        const joinTime = dayjs(this.userTimeMap.get(entry.userId).joinTime);
        const leaveTime = dayjs(entry.timestamp);
        const duration = dayjs.duration(leaveTime.diff(joinTime));
  
        const devicesType = await this.getLogEntryDevicesType(entry.userId);
  
        if (this.totalTimes.has(entry.userId)) {
          this.totalTimes.set(entry.userId, 0);
        }
  
        const totalTime = duration.asMinutes();
        this.totalTimes.set(entry.userId, totalTime);
  
        await this.saveTotalTime(entry.userId, entry.username, totalTime, oldState.guild.name, {
          devicesType,
          joinTime: entry.timestamp,
        });
        this.sendTotalTimeMessage(oldState, entry);
      }
    } catch (error) {
      console.error('Error handling user total time:', error.message);
    }
  }

  private async saveTotalTime(userId: string, discordName: string, totalTime: number, serverName: string, totalTimeData) {
    try {
      const bangkokTime = dayjs().tz('Asia/Bangkok').format();
      const hours = Math.floor(totalTime / 60);
      const minutes = Math.floor(totalTime % 60);
      const seconds = Math.round((totalTime % 1) * 60);
  
      const existingRecord = await this.userTotalTimeModel.findOne({
        discordId: userId,
        createdAt: {
          $gte: dayjs(bangkokTime).startOf('day').toDate(),
          $lt: dayjs(bangkokTime).endOf('day').toDate(),
        },
      }).lean();
  
      if (existingRecord) {
        existingRecord.joinMethod = existingRecord.joinMethod || [];
        const lastRoundJoinTime = dayjs.utc(totalTimeData.joinTime);
  
        existingRecord.joinMethod.push({
          devicesType: totalTimeData.devicesType,
          totalTime: {
            hours: hours.toString(),
            minutes: minutes.toString(),
            seconds: seconds.toString(),
          },
          joinTime: lastRoundJoinTime.add(hours, 'hours').add(minutes, 'minutes').add(seconds, 'seconds').toDate(),
        });
        existingRecord.serverName = serverName;
  
        await this.userTotalTimeModel.findByIdAndUpdate(
          existingRecord._id,
          {
            $set: {
              joinMethod: existingRecord.joinMethod,
              serverName: existingRecord.serverName,
            },
          }
        );
  
        console.log(`Total time for User ${discordName} on ${bangkokTime} on server ${serverName} updated to ${hours} hours, ${minutes} minutes, ${seconds} seconds`);
      } else {
        const totalTimeEntry = new this.userTotalTimeModel({
          discordName,
          discordId: userId,
          joinMethod: [{
            devicesType: totalTimeData.devicesType,
            totalTime: {
              hours: hours.toString(),
              minutes: minutes.toString(),
              seconds: seconds.toString(),
            },
            joinTime: dayjs(0).utc().toDate(),
          }],
          createdAt: dayjs(bangkokTime).toDate(),
          serverName,
        });
        await totalTimeEntry.save();
        console.log(`Total time for User ${discordName} on ${bangkokTime} on server ${serverName} saved: ${hours} hours, ${minutes} minutes, ${seconds} seconds`);
      }
    } catch (error) {
      console.error('Error saving total time entry:', error.message);
    }
  }

  private async sendTotalTimeMessage(oldState, entry) {
    try {
      if (channelIds.channeltotaltime) {
        const totalTimeInMinutes = this.totalTimes.get(entry.userId);
        const hours = Math.floor(totalTimeInMinutes / 60);
        const minutes = Math.floor(totalTimeInMinutes % 60);
        const seconds = Math.round((totalTimeInMinutes % 1) * 60);

        const totalChannel = oldState.guild.channels.cache.get(channelIds.channeltotaltime) as Discord.TextChannel;
        if (totalChannel) {
          const totalTimeMessage = `\`\`\`User ${entry.username} spent a total of ${hours} hours, ${minutes} minutes, ${seconds} seconds in the voice channel.\`\`\``;
          totalChannel.send(totalTimeMessage);
        } else {
          console.error(`Error: Channel with ID ${channelIds.channeltotaltime} not found.`);
        }
      }
    } catch (error) {
      console.error('Error sending total time message:', error.message);
    }
  }

  private sendLogMessage(channelId: string, message: string) {
    const channel = this.client.guilds.cache.get(serverId).channels.cache.get(channelId) as Discord.TextChannel;
    if (channel) {
      channel.send(`\`\`\`${message}\`\`\``);
    }
  }

  private async getLogEntryDevicesType(userId: string): Promise<string> {
    try {
      const latestLogEntry = await this.logEntryModel.findOne({ userId }).sort({ timestamp: -1 });
      return latestLogEntry?.devicesType || '';
    } catch (error) {
      console.error('Error getting LogEntry devicesType:', error.message);
      return '';
    }
  }

  private async logEntry(newState, entry) {
    try {
      if (!newState.guild) {
        console.error('Error logging entry: Guild information not available.');
        return;
      }

      const devices = checkDevice(newState);

      if (!devices) {
        console.error('Error logging entry: Device information not available.');
        return;
      }

      const timestamp = dayjs(entry.timestamp);
      if (!timestamp.isValid()) {
        console.error('Error logging entry: Invalid timestamp format.');
        return;
      }

      const logEntry = new this.logEntryModel({
        ...entry,
        timestamp: timestamp.tz('Asia/Bangkok').toDate(),
        serverName: newState.guild.name,
        devicesType: devices.join(', '),
      });

      await logEntry.save();
      console.log('User join event saved to MongoDB:', logEntry);

      const message = `User ${entry.username} joined the voice channel at ${logEntry.timestamp} on server ${newState.guild.name} using ${devices.join(', ')}`;
      this.sendLogMessage(channelIds.channelenter, message);

      this.userTimeMap.set(entry.userId, { joinTime: entry.timestamp });
    } catch (error) {
      console.error('Error logging entry:', error.message);
    }
  }

  private async logUserEvent(userId: string, username: string, event: string) {
    try {
      const timestamp = dayjs().tz('Asia/Bangkok').toDate();
      const voiceEvent = await this.voiceEventModel.findOneAndUpdate(
        { userId, username },
        {
          $push: {
            events: {
              event,
              timestamp,
            },
          },
        },
        { upsert: true, new: true }
      );

      console.log(`User ${username} ${event} at ${timestamp}`);
    } catch (error) {
      console.error('Error logging user event:', error.message);
    }
  }

  private async logLeave(oldState, entry) {
    try {
      const logLeave = new this.logLeaveModel({
        ...entry,
        timestamp: dayjs(entry.timestamp).tz('Asia/Bangkok').toDate(),
        serverName: oldState.guild.name,
      });
  
      await logLeave.save();
      console.log('User leave event saved to MongoDB:', logLeave);
  
      const message = `User ${entry.username} left the voice channel at ${logLeave.timestamp} on server ${oldState.guild.name}`;
      this.sendLogMessage(channelIds.channelleave, message);
  
      this.handleUserTotalTime(oldState, entry);
      this.userTimeMap.delete(entry.userId);
    } catch (error) {
      console.error('Error logging leave entry:', error.message);
    }
  }

}